import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { MUSIC } from '../src/definition.ts';
import { MUSIC_DEFAULTS, MUSIC_CONFIG_GROUP, type MusicConfigSection } from '../src/config.ts';
import { MusicWorld } from '../src/world.ts';
import type { AudioFeatures, MediaSession, ProbeCapabilities, ProbeSnapshot } from '../src/types.ts';
import type { MusicProbe } from '../src/probe/audio.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'music-world-')); });
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

function audio(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    ok: true, running: true, sampleRate: 48_000, channels: 2, bits: 32,
    packets: 200, frames: 480_000, staleMs: 20, windowMs: 12_000,
    silentRatio: 0, rmsDb: -14, peakDb: -3, dynamicDb: 9,
    band: { low: 0.2, mid: 0.7, high: 0.1 }, zcr: 0.05, bpm: 96, bpmStrength: 0.6,
    ...overrides,
  };
}

function media(overrides: Partial<MediaSession> = {}): MediaSession {
  return {
    app: 'Spotify.exe', title: 'Creep', artist: 'Radiohead', album: 'Pablo Honey',
    status: 'Playing', positionSec: 83, durationSec: 239, lastUpdatedMs: 0,
    ...overrides,
  };
}

function snapshot(rows: MediaSession[], features = audio()): ProbeSnapshot {
  return {
    at: 0,
    audio: features,
    sessions: rows.map((row) => ({ process: row.app.toLowerCase(), pid: 4242, state: 'active' as const })),
    starts: [],
    media: rows,
  };
}

function fakeProbe(initial = snapshot([media()])): MusicProbe & { current: ProbeSnapshot } {
  const probe = {
    current: initial,
    async capabilities(): Promise<ProbeCapabilities> {
      return { admin: false, smtc: true, startsNote: 'snapshot differencing', loopbackError: '', powershell: '5.1' };
    },
    async snapshot() { return probe.current; },
    async reopen() { return ''; },
    close() {},
  };
  return probe;
}

/** 模拟开机时系统媒体服务还没就绪：能力探测会连续失败。 */
function flakyProbe(initial = snapshot([media()])) {
  const probe = {
    current: initial,
    failCapabilities: true,
    async capabilities(): Promise<ProbeCapabilities> {
      if (probe.failCapabilities) throw new Error('spawn EPERM');
      return { admin: false, smtc: true, startsNote: 'snapshot differencing', loopbackError: '', powershell: '5.1' };
    },
    async snapshot() { return probe.current; },
    async reopen() { return ''; },
    close() {},
  };
  return probe;
}

function make(
  cfg: Partial<MusicConfigSection>,
  probe: MusicProbe,
  now: () => number,
  persist?: (patch: Partial<MusicConfigSection>) => void,
): MusicWorld {
  return new MusicWorld({
    cfg: { ...MUSIC_DEFAULTS, confirmSec: 0, lyrics: false, ...cfg },
    timezone: 'Asia/Shanghai',
    dataDir: scratchDir,
    probe,
    now,
    persist,
  });
}

async function drive(world: MusicWorld): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
  await (world as unknown as { tick(): Promise<void> }).tick();
  await new Promise((r) => setTimeout(r, 20));
}

describe('Music World', () => {  it('干装载不报失败：装载器会接受它', async () => {
    const report = await dryMountWorld(MUSIC, { scratchDir });
    expect(report.failures).toEqual([]);
  });

  it('配置默认值里 enabled 是关的，配置组描述的每个键都在默认值里', () => {
    expect(MUSIC_DEFAULTS.enabled).toBe(false);
    const paths = new Set(Object.keys(MUSIC.defaults()).map((key) => `worlds.music.${key}`));
    for (const path of Object.keys(MUSIC_CONFIG_GROUP.schema.properties)) {
      expect(paths.has(path)).toBe(true);
    }
  });

  it('报出三个工具的名字与环境提示词模板', () => {
    const world = MUSIC.create(fakeWorldContext(MUSIC, { scratchDir }));
    expect(world.tools().map((t) => t.name)).toEqual(['music_now', 'music_lyrics', 'music_history']);
    expect(world.envPromptVars()).toEqual({});
    const docs = world.webUi!().promptDocs ?? [];
    expect(docs.map((d) => d.role)).toEqual(['envPrompt']);
  });

  it('describe 列出的工具与实现一致', () => {
    const world = MUSIC.create(fakeWorldContext(MUSIC, { scratchDir }));
    const declared = MUSIC.describe!.tools.map((t) => t.name).sort();
    expect(world.tools().map((t) => t.name).sort()).toEqual(declared);
    const eventTypes = MUSIC.describe!.events.map((e) => e.type);
    expect(eventTypes).toContain('music.started');
    expect(eventTypes).toContain('music.silent');
  });

  it('第一次识别到歌就报开始，正文带歌名与来源', async () => {
    const probe = fakeProbe();
    const world = make({}, probe, () => 0);
    const host = new FakeHost();
    await world.start(host);
    await drive(world);

    expect(host.events.map((e) => e.type)).toEqual(['music.started']);
    expect(host.events[0].text).toContain('Radiohead《Creep》');
    expect(host.events[0].text).toContain('spotify.exe');
    expect(host.pushOpts[0]?.trigger).toBe('flush');
    await world.stop();
  });

  it('music_now 报出进度与听感', async () => {
    const probe = fakeProbe();
    let now = 0;
    const world = make({}, probe, () => now);
    await world.start(new FakeHost());
    await drive(world);
    now = 5_000;

    const tool = world.tools().find((t) => t.name === 'music_now')!;
    const text = String(await tool.handler({}, {} as ToolCallContext));
    expect(text).toContain('Radiohead《Creep》');
    expect(text).toContain('听感：');
    expect(text).toContain('spotify.exe');
    await world.stop();
  });

  it('歌词开关关着时正文里没有歌词块', async () => {
    const probe = fakeProbe();
    const world = make({ lyrics: false }, probe, () => 0);
    const host = new FakeHost();
    await world.start(host);
    await drive(world);
    expect(host.events[0].text).not.toContain('正在唱');
    await world.stop();
  });

  it('配置了播放器名单时只认名单里的来源', async () => {
    const probe = fakeProbe(snapshot([media()]));
    const world = make({ players: 'foobar' }, probe, () => 0);
    const host = new FakeHost();
    await world.start(host);
    await drive(world);
    // Spotify 不在名单里，所以什么也不报。
    expect(host.events).toEqual([]);
    await world.stop();
  });

  it('抓不到声音时正文指出听不到，而歌名照给', async () => {
    const probe = fakeProbe(snapshot([media()], audio({ packets: 0, silentRatio: 1, rmsDb: -120, windowMs: 0 })));
    let now = 0;
    const world = make({ silentSec: 5 }, probe, () => now);
    const host = new FakeHost();
    await world.start(host);
    const tick = () => (world as unknown as { tick(): Promise<void> }).tick();
    await new Promise((r) => setTimeout(r, 20));
    await tick();
    expect(host.events.map((e) => e.type)).toEqual(['music.started']);

    now += 10_000;
    await tick();
    const silent = host.events.find((e) => e.type === 'music.silent');
    expect(silent).toBeDefined();
    expect(silent!.text).toContain('没有声音经过');
    await world.stop();
  });

  it('一首结束写一条记录，music_history 读得到', async () => {
    const probe = fakeProbe();
    let now = 0;
    const world = make({}, probe, () => now);
    const host = new FakeHost();
    await world.start(host);
    await drive(world);

    probe.current = snapshot([]);
    now = 600_000;
    await (world as unknown as { tick(): Promise<void> }).tick(); // 记为离开，进入宽限期
    now = 700_000;
    await (world as unknown as { tick(): Promise<void> }).tick(); // 过宽限，收尾

    const record = join(scratchDir, 'music-listened.jsonl');
    expect(existsSync(record)).toBe(true);

    const history = world.tools().find((t) => t.name === 'music_history')!;
    const text = String(await history.handler({ days: 1 }, {} as ToolCallContext));
    expect(text).toContain('Creep');
    await world.stop();
  });

  it('面板扫描列出此刻的播放器，保存写回配置', async () => {
    const probe = fakeProbe(snapshot([media(), media({ app: 'foobar2000.exe', title: 'Other' })]));
    const patches: Array<Partial<MusicConfigSection>> = [];
    const world = make({}, probe, () => 0, (patch) => patches.push(patch));
    await world.start(new FakeHost());
    const decl = world.webUi!();
    const rows = await decl.invoke!('players', 'scan', []) as { rows: Array<{ app: string }> };
    expect(rows.rows.map((r) => r.app)).toContain('Spotify.exe');

    await decl.invoke!('players', 'save', [{ picks: ['Spotify.exe'] }]);
    expect(patches).toEqual([{ players: 'Spotify.exe' }]);
  });

  it('不收 Windows 以外的系统', async () => {
    const world = new MusicWorld({
      cfg: { ...MUSIC_DEFAULTS },
      timezone: 'Asia/Shanghai',
      dataDir: scratchDir,
      probe: null,
    });
    const host = new FakeHost();
    await world.start(host);
    expect(host.events).toEqual([]);
    expect(world.tools()).toHaveLength(3);
    await world.stop();
  });

  it('探测子进程第一次起不来时，过一会儿自己恢复', async () => {
    const probe = flakyProbe();
    let now = 1_000;
    const world = make({}, probe, () => now);
    const host = new FakeHost();
    await world.start(host);
    await drive(world);
    expect(host.events).toEqual([]); // 起不来就什么也不报

    probe.failCapabilities = false;
    now += 30_000;
    await drive(world);
    expect(host.events).toEqual([]); // 还在退避窗口里，不去反复起进程

    now += 40_000;
    await drive(world);
    expect(host.events.map((e) => e.type)).toEqual(['music.started']);
    await world.stop();
  });

  it('面板扫描不等退避，立刻就重试', async () => {
    const probe = flakyProbe();
    const world = make({}, probe, () => 1_000);
    await world.start(new FakeHost());
    await drive(world);
    probe.failCapabilities = false;

    const decl = world.webUi!();
    const reply = await decl.invoke!('players', 'scan', []) as { rows: Array<{ app: string }> };
    expect(reply.rows.map((row) => row.app)).toContain('Spotify.exe');
    await world.stop();
  });

  it('探测子进程还没起来时，面板说明清楚而不是说系统没有媒体会话', async () => {
    const probe = flakyProbe();
    const world = make({}, probe, () => 1_000);
    await world.start(new FakeHost());
    await drive(world);

    const decl = world.webUi!();
    const reply = await decl.invoke!('players', 'scan', []) as { rows: unknown[]; note?: string };
    expect(reply.rows).toEqual([]);
    // 面板要把真正的原因说出来，而不是笼统地说"读不到媒体会话"。
    expect(reply.note).toContain('spawn EPERM');
    expect(reply.note).toContain('重试');
    await world.stop();
  });
});
