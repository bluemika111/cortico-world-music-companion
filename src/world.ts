/**
 * 音乐伙伴：轮询系统媒体会话与输出回路，把「他在听什么、放到哪、这段声音什么样」交给模型。
 * 这里不判断该不该搭话、说什么，只写 World 能确认的：歌名、来源、进度、听感、正在唱的那句。
 *
 * 平台细节全在一个常驻 PowerShell 子进程里（scripts/music.ps1）：SMTC 走 WinRT，
 * 声音走 WASAPI loopback，进程启动在提权时走 ETW。本进程只看 JSON。
 */
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ToolCallContext, ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { MUSIC_CONFIG_GROUP, type MusicConfigSection } from './config.ts';
import { LyricsBook, lyricWindowAt, lyricsViewAt, type Lyrics } from './lyrics.ts';
import {
  renderEvent,
  renderHistory,
  renderLyricWindow,
  renderNothing,
  renderNow,
  renderSoundOnly,
  renderUntimedLyrics,
  type EventParts,
  type ListenedRow,
} from './model-text.ts';
import { createMusicProbe, type MusicProbe } from './probe/audio.ts';
import { LIMITS, checkText } from './sanitize.ts';
import type { AudioFeatures, LyricsView, ProbeSnapshot, TrackIdentity } from './types.ts';
import { MusicWatcher, pickSession, trackKeyOf, type MusicEvent } from './watcher.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const RECORD_FILE = 'music-listened.jsonl';
/** 事件正文等歌词等这么久，拿不到就先发。 */
const LYRICS_WAIT_MS = 1_500;
/** 探测子进程没起来时的退避；系统媒体服务在开机后的一小段时间里常常还没就绪。 */
const PROBE_RETRY_MS = 60_000;
/** 连续这么多次采样失败就换一个新的子进程。 */
const PROBE_MAX_FAILURES = 3;

export interface MusicWorldOptions {
  cfg: MusicConfigSection;
  timezone: string;
  dataDir: string;
  /** 写回 `worlds.music`；面板保存播放器名单时用。 */
  persist?: (patch: Partial<MusicConfigSection>) => void;
  /** 测试注入；不给时按平台创建。 */
  probe?: MusicProbe | null;
  now?: () => number;
}

/** 全部工具的声明；definition 的 describe 与 `tools()` 都取它。 */
export const MUSIC_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'music_now',
    description:
      'Report what is playing right now: track, artist, source app, position, what the sound measures like, '
      + 'and the lyric line being sung. Read-only; do not poll it on a timer.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'music_lyrics',
    description:
      'Return the lyric lines around the current position for the track playing now, from LRCLIB. '
      + 'A few lines only, never the whole song. Read-only.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ahead: {
          type: 'integer',
          minimum: 0,
          maximum: 5,
          description: 'How many lines after the current one to include. Default 2.',
        },
      },
    },
  },
  {
    name: 'music_history',
    description:
      'Report which tracks were listened to over the last days, from this World\'s own record file. Read-only.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 30, description: 'How many days back to count. Default 1.' },
      },
    },
  },
];

interface ScanRow {
  app: string;
  title: string;
  playing: boolean;
}

function localTimeFormatter(timezone: string): (at: number) => string {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return (at) => format.format(new Date(at));
}

function parsePlayers(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 播放器上报的原始字段，还没过白名单。 */
interface RawTrack {
  title: string;
  artist: string;
  album: string;
  app: string;
  durationSec: number;
}

function rawTrack(session: {
  app: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
}): RawTrack {
  return {
    title: session.title,
    artist: session.artist,
    album: session.album,
    app: session.app,
    durationSec: session.durationSec,
  };
}

export class MusicWorld implements World {
  readonly id = 'music';

  private host: WorldHost | null = null;
  private probe: MusicProbe | null = null;
  /** 上一次探测初始化失败的退避时刻；到点之前不再起子进程。 */
  private probeRetryAt = 0;
  /** 正在进行的初始化，避免同一时刻并发出两遍。 */
  private probeInit: Promise<MusicProbe | null> | null = null;
  /** 连续采样失败次数；够多次就换一个新的子进程。 */
  private probeFailures = 0;
  /** 上一次初始化失败的原因，面板直接显示，省得猜。 */
  private probeLastError = '';
  /** 平台不支持时只记一次日志。 */
  private probeUnsupported = false;
  private watcher: MusicWatcher;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking = false;
  private readonly book = new LyricsBook();
  /** 预热过的歌词：渲染正文时只读这里，慢的网络不拖住事件。 */
  private readonly warm = new Map<string, Lyrics | null>();
  private lastSnapshot: ProbeSnapshot | null = null;
  private readonly localTime: (at: number) => string;
  private readonly clock: () => number;

  constructor(private readonly opts: MusicWorldOptions) {
    this.localTime = localTimeFormatter(opts.timezone);
    this.clock = opts.now ?? Date.now;
    this.watcher = this.newWatcher();
  }

  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [this.nowTool(), this.lyricsTool(), this.historyTool()];
  }

  webUi(language = 'zh'): WorldWebUiDecl {
    const zh = language !== 'en';
    return {
      config: [MUSIC_CONFIG_GROUP],
      panels: [
        {
          id: 'players',
          title: zh ? '播放器' : 'Players',
          description: zh
            ? '此刻系统里在出声或被识别到的播放器。勾上就只认这些；全不勾表示所有播放器都算。'
            : 'Players that are audible or recognised right now. Ticked means only those count; none ticked means any player.',
        },
      ],
      invoke: (panel, method, args) => this.invokePanel(panel, method, args),
      promptDocs: [
        {
          key: 'worlds.music.envPrompt',
          title: zh ? '音乐伙伴 · 环境提示词' : 'Music Companion · environment prompt',
          description: zh
            ? '说明这些事件是什么、什么时候来，以及「听不到声音」意味着什么。'
            : 'What these events are, when they arrive, and what it means when no sound can be heard.',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.running = true;
    this.watcher = this.newWatcher();
    this.probeRetryAt = 0;
    // 这里不等探测就绪：系统媒体服务没起来时那一次会失败，挂载不该被它卡住。
    this.schedule();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.probe?.close();
    this.probe = null;
    this.probeInit = null;
    this.probeRetryAt = 0;
    this.probeFailures = 0;
    this.probeUnsupported = false;
    this.watcher.reset();
    this.warm.clear();
    this.host = null;
  }

  /**
   * 惰性取得探测子进程。启动那一刻系统媒体服务常常还没就绪，失败不能就此放弃：
   * 退避一会儿再试，面板上的「扫描播放器」则立刻重试一次。
   */
  private async ensureProbe(force = false): Promise<MusicProbe | null> {
    if (this.probe) return this.probe;
    if (this.opts.probe === null) return null; // 调用方明确说这个系统上没有
    if (this.probeInit) return this.probeInit;
    if (!force && this.clock() < this.probeRetryAt) return null;

    this.probeInit = (async () => {
      const probe = this.opts.probe === undefined ? createMusicProbe() : this.opts.probe;
      if (!probe) {
        if (!this.probeUnsupported) {
          this.probeUnsupported = true;
          this.host?.log.warn('音乐伙伴只支持 Windows；这个系统上读不到媒体会话，不发事件。');
        }
        this.probeRetryAt = Number.POSITIVE_INFINITY;
        return null;
      }
      try {
        const caps = await probe.capabilities();
        if (!caps.smtc) {
          try { probe.close(); } catch { /* 已经退出 */ }
          this.probeLastError = 'powershell 起来了，但读不到系统媒体会话（SMTC 初始化失败）';
          this.host?.log.warn('读不到系统媒体会话（SMTC），稍后再试。');
          this.probeRetryAt = this.clock() + PROBE_RETRY_MS;
          return null;
        }
        if (caps.loopbackError) {
          this.host?.log.warn('输出回路打不开，这一项只有歌名、没有听感。', { error: caps.loopbackError });
        }
        this.host?.log.debug('进程启动检测按进程快照差分。', { reason: caps.startsNote });
        this.probe = probe;
        this.probeFailures = 0;
        this.probeLastError = '';
        return probe;
      } catch (err) {
        this.probeLastError = err instanceof Error ? err.message : String(err);
        this.host?.log.warn('音乐探测进程没有起来，稍后再试', { err });
        try { probe.close(); } catch { /* 已经退出 */ }
        this.probeRetryAt = this.clock() + PROBE_RETRY_MS;
        return null;
      } finally {
        this.probeInit = null;
      }
    })();
    return this.probeInit;
  }

  private async invokePanel(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel !== 'players') throw new Error(`unknown panel: ${panel}`);
    if (method === 'scan') return this.scanPlayers(true);
    if (method === 'save') return this.savePlayers(args[0]);
    throw new Error(`unknown method: ${method}`);
  }

  /** 此刻系统里认识的播放器，给面板勾选。面板点一次就立刻重试，不必等退避。 */
  private async scanPlayers(force = false): Promise<{ rows: ScanRow[]; selected: string[]; note?: string }> {
    const probe = await this.ensureProbe(force);
    if (!probe) {
      const why = this.probeLastError || '探测进程还没起来';
      return {
        rows: [],
        selected: parsePlayers(this.opts.cfg.players),
        note: `${why}。一分钟内会自动重试；再点一次「扫描播放器」可以立刻重试。`,
      };
    }
    let snapshot: ProbeSnapshot;
    try {
      snapshot = await probe.snapshot();
    } catch (err) {
      return { rows: [], selected: [], note: `探测失败：${err instanceof Error ? err.message : String(err)}` };
    }
    const seen = new Map<string, ScanRow>();
    for (const session of snapshot.media) {
      if (!session.app) continue;
      const existing = seen.get(session.app);
      const playing = session.status === 'Playing';
      if (!existing || (playing && !existing.playing)) {
        seen.set(session.app, { app: session.app, title: session.title, playing });
      }
    }
    for (const session of snapshot.sessions) {
      if (!session.process || session.state !== 'active') continue;
      const app = session.process;
      if (!seen.has(app)) seen.set(app, { app, title: '', playing: true });
    }
    return {
      rows: [...seen.values()].sort((a, b) => Number(b.playing) - Number(a.playing) || a.app.localeCompare(b.app)),
      selected: parsePlayers(this.opts.cfg.players),
    };
  }

  private savePlayers(payload: unknown): { ok: true; players: string } {
    const body = (payload ?? {}) as { picks?: unknown };
    const picks = Array.isArray(body.picks)
      ? body.picks.map((p) => String(p).trim()).filter(Boolean)
      : [];
    const players = [...new Set(picks)].join(', ');
    this.opts.persist?.({ players });
    return { ok: true, players };
  }

  private newWatcher(): MusicWatcher {
    return new MusicWatcher({
      confirmMs: Math.max(0, this.opts.cfg.confirmSec) * 1000,
      endGraceMs: Math.max(10, this.opts.cfg.endGraceSec) * 1000,
      noteMs: Math.max(0, this.opts.cfg.noteSec) * 1000,
      silentAfterMs: Math.max(5, this.opts.cfg.silentSec) * 1000,
      now: () => this.clock(),
    });
  }

  private schedule(): void {
    if (!this.running) return;
    const seconds = Math.max(2, Math.floor(this.opts.cfg.pollSec));
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, seconds * 1000);
    this.timer.unref?.();
  }

  /** 配置了播放器名单时，只留下一名下这些来源。 */
  private filterSnapshot(snapshot: ProbeSnapshot): ProbeSnapshot {
    const allowed = parsePlayers(this.opts.cfg.players);
    if (allowed.length === 0) return snapshot;
    const matches = (app: string): boolean => {
      const hay = app.toLowerCase();
      return allowed.some((needle) => hay.includes(needle));
    };
    return {
      ...snapshot,
      media: snapshot.media.filter((m) => matches(m.app)),
      sessions: snapshot.sessions.filter((s) => matches(s.process)),
    };
  }

  private async tick(): Promise<void> {
    const host = this.host;
    if (!this.running || !host || this.ticking) return;
    this.ticking = true;
    try {
      const probe = await this.ensureProbe();
      if (!probe) return;
      let snapshot: ProbeSnapshot;
      try {
        snapshot = this.filterSnapshot(await probe.snapshot());
        this.probeFailures = 0;
      } catch (err) {
        // 采样失败不等于他关掉了音乐：这一拍跳过，状态保持不变。
        this.probeFailures += 1;
        host.log.warn('音乐探测采样失败', { err, failures: this.probeFailures });
        if (this.probeFailures >= PROBE_MAX_FAILURES) {
          // 连续失败说明这个子进程已经不中用了，丢掉它，下一拍重新起一个。
          try { probe.close(); } catch { /* 已经退出 */ }
          this.probe = null;
          this.probeFailures = 0;
          this.probeRetryAt = 0;
        }
        return;
      }
      this.lastSnapshot = snapshot;

      const chosen = pickSession(snapshot);
      if (chosen) this.warmLyrics(rawTrack(chosen));
      this.noteStarts(host, snapshot, chosen !== null);

      const events = this.watcher.tick(snapshot);
      for (const event of events) await this.report(host, event);
    } finally {
      this.ticking = false;
    }
  }

  /** 名单里的播放器刚启动、但还没有媒体会话时记一条日志，不打扰模型。 */
  private noteStarts(host: WorldHost, snapshot: ProbeSnapshot, hasSession: boolean): void {
    if (hasSession || snapshot.starts.length === 0) return;
    const allowed = parsePlayers(this.opts.cfg.players);
    if (allowed.length === 0) return;
    for (const start of snapshot.starts) {
      if (allowed.some((needle) => start.name.includes(needle))) {
        host.log.debug('播放器已启动，还没建立媒体会话', { process: start.name });
      }
    }
  }

  /** 提前把这一首的歌词取回来；同一首只发一次请求。 */
  private warmLyrics(raw: RawTrack): void {
    if (!this.opts.cfg.lyrics) return;
    const cleaned = this.sanitizeTrack(raw);
    if (!cleaned.track) return;
    const track = cleaned.track;
    if (this.warm.has(track.key)) return;
    this.warm.set(track.key, null);
    void this.book.get(track).then((lyrics) => {
      this.warm.set(track.key, lyrics);
    }).catch(() => {
      this.warm.set(track.key, null);
    });
  }

  /** 等到歌词就带上，等不到就先发。 */
  private async waitForLyrics(track: TrackIdentity): Promise<Lyrics | null> {
    if (!this.opts.cfg.lyrics) return null;
    const cached = this.warm.get(track.key);
    if (cached !== undefined) return cached;
    if (this.warm.size > 128) this.warm.clear();
    const started = this.clock();
    const pending = this.book.get(track);
    this.warm.set(track.key, null);
    const lyrics = await Promise.race([
      pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LYRICS_WAIT_MS)),
    ]);
    if (lyrics) this.warm.set(track.key, lyrics);
    else if (this.clock() - started < LYRICS_WAIT_MS) this.warm.set(track.key, null);
    return lyrics;
  }

  private viewOf(track: TrackIdentity, positionSec: number, lyrics: Lyrics | null): LyricsView | null {
    if (!lyrics || !lyrics.timed) return null;
    return lyricsViewAt(lyrics, positionSec);
  }

  /**
   * 播放器上报的是外部文本，进正文之前过一遍白名单。曲名用不了就整段不给——
   * 它决定正文里还有没有"这首歌叫什么"，比歌手和专辑重要。
   */
  private sanitizeTrack(raw: RawTrack): { track: TrackIdentity | null; note: string } {
    const title = checkText(raw.title, LIMITS.title);
    if (!title.text) {
      return { track: null, note: title.rejected || '曲名为空' };
    }
    const artist = checkText(raw.artist, LIMITS.artist);
    const album = checkText(raw.album, LIMITS.album);
    const app = checkText(raw.app.toLowerCase(), LIMITS.app);
    return {
      track: {
        key: trackKeyOf(app.text, title.text, artist.text),
        title: title.text,
        artist: artist.text,
        album: album.text,
        app: app.text,
        durationSec: raw.durationSec,
      },
      note: '',
    };
  }

  /** 歌词这一拍为什么没给；空串表示给了，或者本来就没打开。 */
  private lyricsNoteFor(lyrics: Lyrics | null): string {
    if (!this.opts.cfg.lyrics || !lyrics) return '';
    if (lyrics.rejected) return `内容形状异常（${lyrics.rejected}）`;
    if (lyrics.instrumental) return '这首被标成纯音乐';
    if (!lyrics.timed) return '歌词没有时间轴，对不上此刻唱到哪一句';
    return '';
  }

  /** 把一条事件要进正文的东西准备好：曲目与歌词都净化过，用不了的部分给出说明。 */
  private async partsFor(event: MusicEvent, positionSec: number): Promise<EventParts> {
    const cleaned = this.sanitizeTrack(event.track);
    const from = 'from' in event && event.from ? this.sanitizeTrack(event.from).track : null;

    let lyrics: Lyrics | null = null;
    let view: LyricsView | null = null;
    if (cleaned.track && this.opts.cfg.lyrics) {
      lyrics = await this.waitForLyrics(cleaned.track);
      view = this.viewOf(cleaned.track, positionSec, lyrics);
    }

    return {
      track: cleaned.track,
      from,
      lyrics: view,
      lyricsNote: this.lyricsNoteFor(lyrics),
      trackNote: cleaned.note,
    };
  }

  private async report(host: WorldHost, event: MusicEvent): Promise<void> {
    const positionSec = 'positionSec' in event ? event.positionSec : 0;
    const audio: AudioFeatures | null = event.kind === 'stopped'
      ? null
      : this.lastSnapshot?.audio ?? emptyAudio();
    const parts = await this.partsFor(event, positionSec);

    let text: string;
    if (event.kind === 'note') {
      const now = this.watcher.snapshotWithAudio(audio ?? emptyAudio());
      text = now
        ? renderNow(now, parts, { localTime: this.localTime })
        : renderEvent(event, parts, { localTime: this.localTime }, audio);
    } else {
      text = renderEvent(event, parts, { localTime: this.localTime }, audio);
    }

    await host.pushEvent(
      {
        type: `music.${event.kind}`,
        ts: nowIso(this.opts.timezone),
        source: this.id,
        senderKey: this.id,
        text,
        meta: {
          track: parts.track?.title ?? '',
          artist: parts.track?.artist ?? '',
          app: parts.track?.app ?? '',
          positionSec: Math.round(positionSec),
          lyric: parts.lyrics?.current ?? '',
        },
      },
      { trigger: 'flush' },
    );

    if (event.kind === 'stopped') await this.record(host, event.track, event.playedMs);
  }

  private async record(host: WorldHost, track: TrackIdentity, ms: number): Promise<void> {
    const dir = this.opts.dataDir;
    if (!dir || ms < 5_000) return; // 一掠而过的切歌不值得记
    const name = track.artist ? `${track.artist}《${track.title}》` : `《${track.title}》`;
    const row = {
      track: track.key,
      name,
      app: track.app,
      ms,
      endedAt: new Date(this.clock()).toISOString(),
    };
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(join(dir, RECORD_FILE), `${JSON.stringify(row)}\n`, 'utf8');
    } catch (err) {
      host.log.warn('写入听歌记录失败', { err });
    }
  }

  private nowTool(): ToolDef {
    return {
      ...MUSIC_TOOL_DECLS[0],
      handler: async () => {
        const probe = await this.ensureProbe();
        if (!probe) return `探测子进程还没起来${this.probeLastError ? `（${this.probeLastError}）` : ''}，稍后再试一次。`;
        let snapshot: ProbeSnapshot;
        try {
          snapshot = this.filterSnapshot(await probe.snapshot());
        } catch (err) {
          return `探测失败：${err instanceof Error ? err.message : String(err)}`;
        }

        const playing = this.watcher.snapshotWithAudio(snapshot.audio);
        if (playing) {
          const parts = await this.partsFromTrack(playing.track, playing.positionSec);
          return renderNow(playing, parts, { localTime: this.localTime });
        }

        const chosen = pickSession(snapshot);
        if (chosen) {
          const parts = await this.partsFromTrack(rawTrack(chosen), chosen.positionSec);
          // 曲目不可用时正文走「只剩声音」那一路，不读这里给的名字。
          const placeholder: TrackIdentity = {
            key: '',
            title: '',
            artist: '',
            album: '',
            app: '',
            durationSec: chosen.durationSec,
          };
          const fake = {
            at: this.clock(),
            track: parts.track ?? placeholder,
            state: chosen.status === 'Paused' ? 'paused' as const : 'playing' as const,
            positionSec: chosen.positionSec,
            audio: snapshot.audio,
            silentButPlaying: false,
            elapsedMs: 0,
          };
          return renderNow(fake, parts, { localTime: this.localTime });
        }
        if (snapshot.sessions.length > 0) return renderSoundOnly('');
        return renderNothing();
      },
    };
  }

  /** 工具回执用：按原始曲目算一份净化的上下文。 */
  private async partsFromTrack(raw: RawTrack, positionSec: number): Promise<EventParts> {
    const cleaned = this.sanitizeTrack(raw);
    let lyrics: Lyrics | null = null;
    let view: LyricsView | null = null;
    if (cleaned.track && this.opts.cfg.lyrics) {
      lyrics = await this.waitForLyrics(cleaned.track);
      view = this.viewOf(cleaned.track, positionSec, lyrics);
    }
    return {
      track: cleaned.track,
      from: null,
      lyrics: view,
      lyricsNote: this.lyricsNoteFor(lyrics),
      trackNote: cleaned.note,
    };
  }

  /** 当前这一段的歌词，只给窗口里的几句；不给整首。 */
  private lyricsTool(): ToolDef {
    return {
      ...MUSIC_TOOL_DECLS[1],
      handler: async (args: Record<string, unknown>) => {
        if (!this.opts.cfg.lyrics) return '同步歌词这个开关是关着的。';
        const probe = await this.ensureProbe();
        if (!probe) return `探测子进程还没起来${this.probeLastError ? `（${this.probeLastError}）` : ''}，稍后再试一次。`;
        let snapshot: ProbeSnapshot;
        try {
          snapshot = this.filterSnapshot(await probe.snapshot());
        } catch (err) {
          return `探测失败：${err instanceof Error ? err.message : String(err)}`;
        }
        const chosen = pickSession(snapshot);
        if (!chosen) return '此刻没有在放歌，没有歌词可给。';

        const cleaned = this.sanitizeTrack(rawTrack(chosen));
        if (!cleaned.track) {
          return `这首歌的曲目信息不可用（${cleaned.note || '曲名为空'}），对不上歌词库里的哪一首。`;
        }

        const lyrics = await this.book.get(cleaned.track);
        if (!lyrics) return `LRCLIB 上没有 ${cleaned.track.artist ? `${cleaned.track.artist}《${cleaned.track.title}》` : `《${cleaned.track.title}》`} 的歌词。`;
        if (lyrics.rejected) return `${cleaned.track.title} 的歌词内容形状异常（${lyrics.rejected}），已跳过。`;
        if (lyrics.instrumental) return `${cleaned.track.title} 在 LRCLIB 上被标成纯音乐，没有歌词。`;
        if (!lyrics.timed) return renderUntimedLyrics(cleaned.track);

        const ahead = Math.min(5, Math.max(0, Number(args.ahead) || 2));
        const rows = lyricWindowAt(lyrics, chosen.positionSec, ahead);
        return renderLyricWindow(cleaned.track, rows);
      },
    };
  }

  private historyTool(): ToolDef {
    return {
      ...MUSIC_TOOL_DECLS[2],
      handler: async (args: Record<string, unknown>, _ctx: ToolCallContext) => {
        const days = Math.min(30, Math.max(1, Number(args.days) || 1));
        return this.historyText(days);
      },
    };
  }

  private async historyText(days: number): Promise<string> {
    const dir = this.opts.dataDir;
    if (!dir) return '还没有听歌记录。';
    let raw: string;
    try {
      raw = await fs.readFile(join(dir, RECORD_FILE), 'utf8');
    } catch {
      return '还没有听歌记录。';
    }
    const since = this.clock() - days * 86_400_000;
    const totals = new Map<string, ListenedRow>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let row: { track?: string; name?: string; ms?: number; endedAt?: string };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        continue;
      }
      if (!row.endedAt || typeof row.ms !== 'number') continue;
      const endedAt = Date.parse(row.endedAt);
      if (!Number.isFinite(endedAt) || endedAt < since) continue;
      const key = row.track ?? row.name ?? '';
      if (!key) continue;
      const entry = totals.get(key) ?? { track: key, name: row.name ?? key, ms: 0 };
      entry.ms += row.ms;
      totals.set(key, entry);
    }
    return renderHistory([...totals.values()], days);
  }
}

function emptyAudio(): ProbeSnapshot['audio'] {
  return {
    ok: false,
    running: false,
    sampleRate: 0,
    channels: 0,
    bits: 0,
    packets: 0,
    frames: 0,
    staleMs: -1,
    windowMs: 0,
    silentRatio: 1,
    rmsDb: -120,
    peakDb: -120,
    dynamicDb: 0,
    band: { low: 0, mid: 0, high: 0 },
    zcr: 0,
    bpm: 0,
    bpmStrength: 0,
  };
}
