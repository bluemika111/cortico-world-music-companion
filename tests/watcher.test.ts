import { describe, expect, it } from 'vitest';
import type { AudioFeatures, MediaSession, ProbeSnapshot } from '../src/types.ts';
import { MusicWatcher, looksSilent, pickSession, trackKeyOf, type MusicWatcherOptions } from '../src/watcher.ts';

function audio(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    ok: true,
    running: true,
    sampleRate: 48_000,
    channels: 2,
    bits: 32,
    packets: 120,
    frames: 480_000,
    staleMs: 20,
    windowMs: 12_000,
    silentRatio: 0,
    rmsDb: -14,
    peakDb: -3,
    dynamicDb: 9,
    band: { low: 0.2, mid: 0.7, high: 0.1 },
    zcr: 0.05,
    bpm: 96,
    bpmStrength: 0.6,
    ...overrides,
  };
}

function media(overrides: Partial<MediaSession> = {}): MediaSession {
  return {
    app: 'Spotify.exe',
    title: 'Creep',
    artist: 'Radiohead',
    album: 'Pablo Honey',
    status: 'Playing',
    positionSec: 0,
    durationSec: 239,
    lastUpdatedMs: 0,
    ...overrides,
  };
}

function snap(at: number, rows: MediaSession[], features: AudioFeatures = audio()): ProbeSnapshot {
  return { at, audio: features, sessions: [], starts: [], media: rows };
}

function makeWatcher(now: () => number, overrides: Partial<MusicWatcherOptions> = {}) {
  return new MusicWatcher({
    confirmMs: 4_000,
    endGraceMs: 90_000,
    noteMs: 300_000,
    silentAfterMs: 20_000,
    now,
    ...overrides,
  });
}

describe('pickSession', () => {
  it('正在播放的优先于暂停的', () => {
    const chosen = pickSession(snap(0, [
      media({ status: 'Paused', title: 'a', lastUpdatedMs: 900 }),
      media({ status: 'Playing', title: 'b', lastUpdatedMs: 100 }),
    ]));
    expect(chosen?.title).toBe('b');
  });

  it('都没有标题时返回 null', () => {
    expect(pickSession(snap(0, [media({ title: '  ' })]))).toBeNull();
  });

  it('没有会话时返回 null', () => {
    expect(pickSession(snap(0, []))).toBeNull();
  });
});

describe('looksSilent', () => {
  it('从没读到过音频包算抓不到声音', () => {
    expect(looksSilent(true, audio({ packets: 0 }))).toBe(true);
  });

  it('窗口里几乎全静音算抓不到声音', () => {
    expect(looksSilent(true, audio({ silentRatio: 0.99, rmsDb: -90 }))).toBe(true);
  });

  it('有声音时不算', () => {
    expect(looksSilent(true, audio())).toBe(false);
  });

  it('没在播放时不谈抓不到', () => {
    expect(looksSilent(false, audio({ packets: 0 }))).toBe(false);
  });
});

describe('MusicWatcher', () => {
  it('一首歌待够确认时间才报开始', () => {
    let now = 1_000;
    const w = makeWatcher(() => now);
    expect(w.tick(snap(now, [media()]))).toEqual([]);
    now += 3_000;
    expect(w.tick(snap(now, [media()]))).toEqual([]);
    now += 1_500;
    const events = w.tick(snap(now, [media()]));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('started');
  });

  it('换歌报上一首与这一首', () => {
    let now = 1_000;
    const w = makeWatcher(() => now);
    w.tick(snap(now, [media()]));
    now += 5_000;
    w.tick(snap(now, [media()]));
    now += 5_000;
    const events = w.tick(snap(now, [media({ title: 'High and Dry', artist: 'Radiohead' })]));
    expect(events).toEqual([]); // 新歌还没待够确认时间
    now += 5_000;
    const confirmed = w.tick(snap(now, [media({ title: 'High and Dry', artist: 'Radiohead' })]));
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].kind).toBe('track_changed');
    if (confirmed[0].kind === 'track_changed') {
      expect(confirmed[0].from.title).toBe('Creep');
      expect(confirmed[0].track.title).toBe('High and Dry');
    }
  });

  it('暂停与继续各报一次', () => {
    let now = 1_000;
    const w = makeWatcher(() => now);
    w.tick(snap(now, [media()]));
    now += 5_000;
    w.tick(snap(now, [media()]));
    now += 2_000;
    const paused = w.tick(snap(now, [media({ status: 'Paused', positionSec: 7, lastUpdatedMs: now })]));
    expect(paused.map((e) => e.kind)).toEqual(['paused']);
    now += 2_000;
    const resumed = w.tick(snap(now, [media({ status: 'Playing', positionSec: 7, lastUpdatedMs: now })]));
    expect(resumed.map((e) => e.kind)).toEqual(['resumed']);
  });

  it('消失超过宽限才算结束，并报出实际播了多久', () => {
    let now = 1_000;
    const w = makeWatcher(() => now);
    w.tick(snap(now, [media()]));
    now += 5_000;
    w.tick(snap(now, [media()]));
    now += 30_000;
    w.tick(snap(now, [media()]));
    now += 10_000;
    expect(w.tick(snap(now, []))).toEqual([]); // 还在宽限内
    now += 90_000;
    const events = w.tick(snap(now, []));
    expect(events.map((e) => e.kind)).toEqual(['stopped']);
    if (events[0].kind === 'stopped') {
      // 累计的是真正在播放的时间，不含播放器已经消失的那段。
      expect(events[0].playedMs).toBeGreaterThanOrEqual(30_000);
      expect(events[0].playedMs).toBeLessThan(50_000);
    }
  });

  it('播放中按间隔递摘要', () => {
    let now = 1_000;
    const w = makeWatcher(() => now, { noteMs: 60_000 });
    w.tick(snap(now, [media()]));
    now += 5_000;
    w.tick(snap(now, [media()]));
    now += 61_000;
    const events = w.tick(snap(now, [media()]));
    expect(events.map((e) => e.kind)).toEqual(['note']);
  });

  it('抓不到声音持续够久才报一次，不重复报', () => {
    let now = 1_000;
    const w = makeWatcher(() => now, { silentAfterMs: 20_000 });
    const silent = audio({ packets: 0, silentRatio: 1, rmsDb: -120, windowMs: 0 });
    w.tick(snap(now, [media()], silent));
    now += 5_000;
    w.tick(snap(now, [media()], silent)); // 认下这首歌，静音从这一刻起算
    now += 10_000;
    expect(w.tick(snap(now, [media()], silent)).map((e) => e.kind)).toEqual([]); // 还不够久
    now += 25_000;
    const first = w.tick(snap(now, [media()], silent));
    expect(first.map((e) => e.kind)).toEqual(['silent']);
    now += 30_000;
    const second = w.tick(snap(now, [media()], silent));
    expect(second.map((e) => e.kind)).not.toContain('silent');
  });

  it('同一个 key 的同一首歌不会重复报开始', () => {
    let now = 1_000;
    const w = makeWatcher(() => now);
    w.tick(snap(now, [media()]));
    now += 5_000;
    w.tick(snap(now, [media()]));
    for (let i = 0; i < 5; i++) {
      now += 5_000;
      expect(w.tick(snap(now, [media()]))).toEqual([]);
    }
  });

  it('进度按本地时钟外推，不依赖播放器频繁更新', () => {
    let now = 1_000;
    const w = makeWatcher(() => now);
    w.tick(snap(now, [media({ lastUpdatedMs: now, positionSec: 10 })]));
    now += 5_000;
    w.tick(snap(now, [media({ lastUpdatedMs: 1_000, positionSec: 10 })]));
    now += 10_000;
    w.tick(snap(now, [media({ lastUpdatedMs: 1_000, positionSec: 10 })]));
    const playing = w.snapshotWithAudio(audio());
    expect(playing?.positionSec).toBeGreaterThan(24);
    expect(playing?.positionSec).toBeLessThan(26);
  });
});

describe('trackKeyOf', () => {
  it('大小写与多余空格不影响身份', () => {
    expect(trackKeyOf('Spotify.exe', 'Creep', 'Radiohead'))
      .toBe(trackKeyOf('spotify.exe', '  Creep ', 'radiohead'));
  });

  it('换歌换人就是另一个 key', () => {
    expect(trackKeyOf('a', 'Creep', 'Radiohead')).not.toBe(trackKeyOf('a', 'Creep', 'Muse'));
  });
});
