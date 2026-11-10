/**
 * 探测子进程的 Node 侧封装。窗口查询、COM 与 DSP 都在 scripts/music.ps1 里，
 * World 进程只经 stdio 要结果：声卡句柄与成百兆采样不跨进程，子进程崩了也不带走 World。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AudioFeatures, AudioSessionRow, MediaSession, ProbeCapabilities, ProbeSnapshot } from '../types.ts';

const SCRIPT = fileURLToPath(new URL('../../scripts/music.ps1', import.meta.url));

/**
 * Windows PowerShell 的绝对路径。宿主是 Electron 应用，它的 PATH 里不一定有
 * `System32\WindowsPowerShell\v1.0`，只写裸命令名会在那种环境里直接 spawn 失败。
 */
function powershellPath(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const full = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(full) ? full : 'powershell.exe';
}

const POWERSHELL = powershellPath();
const HELLO_TIMEOUT_MS = 20_000;
const SNAPSHOT_TIMEOUT_MS = 8_000;

interface Reply {
  id?: number;
  ok?: boolean;
  error?: string;
  fatal?: string;
  admin?: boolean;
  smtc?: boolean;
  /** hello 回复里的进程启动来源说明，与 snapshot 的 starts 数组不是同一个字段。 */
  startsSource?: string;
  loopbackError?: string;
  powershell?: string;
  at?: number;
  audio?: AudioFeatures;
  sessions?: AudioSessionRow[];
  starts?: Array<{ name?: string; ticks?: number }>;
  media?: MediaSession[];
}

interface Pending {
  resolve: (reply: Reply) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** 探测子进程的接口。测试注入假实现。 */
export interface MusicProbe {
  capabilities(): Promise<ProbeCapabilities>;
  snapshot(): Promise<ProbeSnapshot>;
  /** 输出设备换了以后重建 loopback 客户端。 */
  reopen(): Promise<string>;
  close(): void;
}

export class WindowsMusicProbe implements MusicProbe {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private caps: ProbeCapabilities | null = null;
  /** 子进程吐过 fatal 后不再重试，避免每次采样都重启一个必然失败的进程。 */
  private fatal: string | null = null;

  async capabilities(): Promise<ProbeCapabilities> {
    if (this.caps) return this.caps;
    const reply = await this.call({ cmd: 'hello' }, HELLO_TIMEOUT_MS);
    const caps: ProbeCapabilities = {
      admin: reply.admin === true,
      smtc: reply.smtc === true,
      startsNote: typeof reply.startsSource === 'string' ? reply.startsSource : '',
      loopbackError: typeof reply.loopbackError === 'string' ? reply.loopbackError : '',
      powershell: typeof reply.powershell === 'string' ? reply.powershell : '',
    };
    this.caps = caps;
    return caps;
  }

  async snapshot(): Promise<ProbeSnapshot> {
    const reply = await this.call({ cmd: 'snapshot' }, SNAPSHOT_TIMEOUT_MS);
    return {
      at: typeof reply.at === 'number' ? reply.at : Date.now(),
      audio: normalizeAudio(reply.audio),
      sessions: Array.isArray(reply.sessions) ? reply.sessions : [],
      starts: Array.isArray(reply.starts)
        ? reply.starts
            .filter((s) => typeof s.name === 'string' && s.name.length > 0)
            .map((s) => ({ name: String(s.name), ticks: typeof s.ticks === 'number' ? s.ticks : 0 }))
        : [],
      media: Array.isArray(reply.media) ? reply.media : [],
    };
  }

  async reopen(): Promise<string> {
    const reply = await this.call({ cmd: 'reopen' }, SNAPSHOT_TIMEOUT_MS);
    return typeof reply.error === 'string' ? reply.error : '';
  }

  close(): void {
    const child = this.child;
    this.child = null;
    this.caps = null;
    if (!child) return;
    try {
      child.stdin.write(`${JSON.stringify({ cmd: 'stop' })}\n`);
    } catch { /* 已经断开 */ }
    try {
      child.kill();
    } catch { /* 已经退出 */ }
    this.failAll(new Error('探测进程已关闭'));
  }

  private async call(request: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    if (this.fatal) throw new Error(this.fatal);
    const child = this.ensure();
    const id = ++this.seq;
    const line = `${JSON.stringify({ ...request, id })}\n`;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`音乐探测 ${String(request.cmd)} 超时`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(line, (err) => {
        if (!err) return;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(err);
      });
    });
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.read(chunk));
    child.stderr.on('data', () => { /* 脚本自己的报错走响应体 */ });
    child.on('exit', () => this.failAll(new Error('音乐探测进程已退出')));
    child.on('error', (err) => this.failAll(err));
    this.child = child;
    return child;
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.dispatch(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let reply: Reply;
    try {
      reply = JSON.parse(line) as Reply;
    } catch {
      return; // 脚本输出里混进别的行时跳过
    }
    const id = reply.id;
    if (typeof id !== 'number') {
      if (typeof reply.fatal === 'string') this.fatal = reply.fatal;
      return;
    }
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (reply.ok === false) p.reject(new Error(reply.error || '音乐探测失败'));
    else p.resolve(reply);
  }

  private failAll(err: Error): void {
    this.child = null;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }
}

/**
 * 子进程给的数缺字段时补成"没有信息"的值，而不是猜一组好看的默认值：
 * silentRatio 补 1、packets 补 0，正文里就会诚实地写成"没有声音经过"。
 */
function normalizeAudio(raw: AudioFeatures | undefined): AudioFeatures {
  const band = raw?.band ?? { low: 0, mid: 0, high: 0 };
  return {
    ok: raw?.ok === true,
    error: typeof raw?.error === 'string' ? raw.error : undefined,
    running: raw?.running === true,
    sampleRate: numberOr(raw?.sampleRate, 0),
    channels: numberOr(raw?.channels, 0),
    bits: numberOr(raw?.bits, 0),
    packets: numberOr(raw?.packets, 0),
    frames: numberOr(raw?.frames, 0),
    staleMs: numberOr(raw?.staleMs, -1),
    windowMs: numberOr(raw?.windowMs, 0),
    silentRatio: numberOr(raw?.silentRatio, 1),
    rmsDb: numberOr(raw?.rmsDb, -120),
    peakDb: numberOr(raw?.peakDb, -120),
    dynamicDb: numberOr(raw?.dynamicDb, 0),
    band: {
      low: numberOr(band.low, 0),
      mid: numberOr(band.mid, 0),
      high: numberOr(band.high, 0),
    },
    zcr: numberOr(raw?.zcr, 0),
    bpm: numberOr(raw?.bpm, 0),
    bpmStrength: numberOr(raw?.bpmStrength, 0),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 按平台创建。非 Windows 返回 null，World 记一条日志后保持安静。 */
export function createMusicProbe(): MusicProbe | null {
  if (process.platform !== 'win32') return null;
  return new WindowsMusicProbe();
}
