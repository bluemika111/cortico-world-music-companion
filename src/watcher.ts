/**
 * 歌曲状态机（纯逻辑，可单测）：把连续的探测快照压成"这一首开始了 / 换了 / 暂停了 / 停了"。
 * 状态机不写句子，正文由 model-text 渲染；它只确认发生了什么、发生在哪一刻。
 */
import type { NowPlaying, ProbeSnapshot, TrackIdentity } from './types.ts';

/** 状态机吐出的时机。 */
export type MusicEvent =
  | { kind: 'started'; at: number; track: TrackIdentity; positionSec: number }
  | { kind: 'track_changed'; at: number; track: TrackIdentity; from: TrackIdentity; positionSec: number }
  | { kind: 'resumed'; at: number; track: TrackIdentity; positionSec: number }
  | { kind: 'paused'; at: number; track: TrackIdentity; positionSec: number }
  | { kind: 'stopped'; at: number; track: TrackIdentity; playedMs: number }
  | { kind: 'note'; at: number; track: TrackIdentity; positionSec: number }
  /** 播放器说在放，但这条 loopback 链路上没有声音经过。 */
  | { kind: 'silent'; at: number; track: TrackIdentity; positionSec: number };

export interface MusicWatcherOptions {
  /** 一首歌要连续待够这么久才算真的在听，用来滤掉切歌与广告的抖动。 */
  confirmMs: number;
  /** 播放器消失或停住多久算这一首结束。 */
  endGraceMs: number;
  /** 播放中每隔多久递一次摘要；0 关闭。 */
  noteMs: number;
  /** 播放器说在放、但抓不到声音多久之后报一次。 */
  silentAfterMs: number;
  now?: () => number;
}

interface Live {
  track: TrackIdentity;
  /** 确认这首歌开始播放的时刻。 */
  startedAt: number;
  /** 累计真正在播放的毫秒数，暂停期间不涨。 */
  playedMs: number;
  playing: boolean;
  positionSec: number;
  /** 上一次读到播放进度的时刻，用来在没有新数据时外推。 */
  positionAt: number;
  /** SMTC 侧最后一次更新进度的时刻。 */
  mediaUpdatedMs: number;
  lastTickAt: number;
  lastNoteAt: number;
  silentReported: boolean;
  silentSince: number | null;
}

/** 一个探测快照里与"在听什么"有关的判断。 */
export function pickSession(snapshot: ProbeSnapshot): ProbeSnapshot['media'][number] | null {
  const usable = snapshot.media.filter((m) => m && m.title.trim().length > 0);
  if (usable.length === 0) return null;
  const playing = usable.filter((m) => m.status === 'Playing');
  const pool = playing.length > 0 ? playing : usable.filter((m) => m.status === 'Paused');
  const candidates = pool.length > 0 ? pool : usable;
  // 同时有几路在播时，取最近更新过元数据的那一路：那才是操作者正在动的那一个。
  return candidates.reduce((best, row) => (row.lastUpdatedMs >= best.lastUpdatedMs ? row : best));
}

export function trackKeyOf(app: string, title: string, artist: string): string {
  return [app, title, artist]
    .map((part) => part.trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');
}

function toTrack(session: ProbeSnapshot['media'][number]): TrackIdentity {
  const app = (session.app || '').toLowerCase();
  return {
    key: trackKeyOf(app, session.title, session.artist),
    title: session.title.trim(),
    artist: session.artist.trim(),
    album: session.album.trim(),
    app,
    durationSec: session.durationSec > 0 ? session.durationSec : 0,
  };
}

/** 播放器报告的进度不可信时，用本地时钟把它推到此刻。 */
function extrapolate(session: ProbeSnapshot['media'][number], now: number, previous: Live | null): number {
  const playing = session.status === 'Playing';
  let position = Math.max(0, session.positionSec);
  if (playing) {
    if (session.lastUpdatedMs > 0) {
      const age = (now - session.lastUpdatedMs) / 1000;
      // 进度停更很久时按本地时钟补，但最多补到上次已知的一首长度。
      if (age > 0 && age < 3600) position += age;
    } else if (previous) {
      position = previous.positionSec + (now - previous.positionAt) / 1000;
    }
  }
  if (session.durationSec > 0) position = Math.min(position, session.durationSec);
  return Math.max(0, position);
}

/** 播放器说在放，但 12 秒窗口里几乎没有能量 —— DRM、独占模式或走了别的设备。 */
export function looksSilent(playing: boolean, audio: ProbeSnapshot['audio']): boolean {
  if (!playing) return false;
  if (audio.packets === 0) return true;
  return audio.silentRatio >= 0.95 && audio.rmsDb <= -55;
}

export class MusicWatcher {
  private readonly opts: MusicWatcherOptions;
  private readonly clock: () => number;
  private live: Live | null = null;
  /** 待确认的新歌：连续出现够 confirmMs 才认。 */
  private pending: { track: TrackIdentity; since: number } | null = null;
  /** 播放器离开的时刻，用来算收尾宽限。 */
  private awaySince: number | null = null;

  constructor(options: MusicWatcherOptions) {
    this.opts = options;
    this.clock = options.now ?? Date.now;
  }

  reset(): void {
    this.live = null;
    this.pending = null;
    this.awaySince = null;
  }

  /** 此刻的样子；没有在听歌时返回 null。 */
  snapshot(): NowPlaying | null {
    const live = this.live;
    if (!live) return null;
    const now = this.clock();
    const positionSec = live.playing ? live.positionSec + (now - live.positionAt) / 1000 : live.positionSec;
    return {
      at: now,
      track: live.track,
      state: live.playing ? 'playing' : 'paused',
      positionSec: live.track.durationSec > 0
        ? Math.min(positionSec, live.track.durationSec)
        : positionSec,
      audio: ZERO_AUDIO,
      silentButPlaying: false,
      elapsedMs: now - live.startedAt,
    };
  }

  /** 当前的音频事实由调用方补进来：状态机只管时间与曲目。 */
  snapshotWithAudio(audio: ProbeSnapshot['audio']): NowPlaying | null {
    const now = this.clock();
    const live = this.live;
    if (!live) return null;
    const positionSec = this.positionOf(live, now);
    return {
      at: now,
      track: live.track,
      state: live.playing ? 'playing' : 'paused',
      positionSec,
      audio,
      silentButPlaying: looksSilent(live.playing, audio),
      elapsedMs: now - live.startedAt,
    };
  }

  tick(snapshot: ProbeSnapshot): MusicEvent[] {
    const now = this.clock();
    const events: MusicEvent[] = [];
    const session = pickSession(snapshot);
    if (!session) {
      this.handleAbsence(now, events);
      return events;
    }

    const track = toTrack(session);
    const playing = session.status === 'Playing';
    const tracked = this.live;
    const sameTrack = tracked !== null && tracked.track.key === track.key;

    if (!sameTrack) {
      // 一首新的歌：先挂起，够久才认，避免切歌、广告与拖动进度条造出一串事件。
      if (!this.pending || this.pending.track.key !== track.key) {
        this.pending = { track, since: now };
      }
      this.awaySince = null;
      const waited = now - this.pending.since;
      if (waited < this.opts.confirmMs) return events;

      const from = tracked?.track ?? null;
      this.pending = null;
      const positionSec = extrapolate(session, now, null);
      this.live = {
        track,
        startedAt: now,
        playedMs: 0,
        playing,
        positionSec,
        positionAt: now,
        mediaUpdatedMs: session.lastUpdatedMs,
        lastTickAt: now,
        lastNoteAt: now,
        silentReported: false,
        silentSince: null,
      };
      if (from) events.push({ kind: 'track_changed', at: now, track, from, positionSec });
      else events.push({ kind: 'started', at: now, track, positionSec });
      return events;
    }

    // 同一首：更新进度与播放状态。
    this.pending = null;
    this.awaySince = null;
    const live = this.live!;
    const delta = now - live.lastTickAt;
    if (live.playing) live.playedMs += Math.max(0, delta);

    const fresh = session.lastUpdatedMs !== live.mediaUpdatedMs
      || Math.abs(session.positionSec - live.positionSec) > 1.5
      || playing !== live.playing;

    if (fresh) {
      live.positionSec = extrapolate(session, now, live);
      live.positionAt = now;
      live.mediaUpdatedMs = session.lastUpdatedMs;
    }
    live.positionSec = this.positionOf(live, now);
    live.positionAt = now;
    live.lastTickAt = now;

    if (playing !== live.playing) {
      live.playing = playing;
      events.push(
        playing
          ? { kind: 'resumed', at: now, track, positionSec: live.positionSec }
          : { kind: 'paused', at: now, track, positionSec: live.positionSec },
      );
      if (!playing) live.silentSince = null;
    }

    if (playing) {
      const silent = looksSilent(true, snapshot.audio);
      if (silent) {
        if (live.silentSince === null) live.silentSince = now;
        if (!live.silentReported && now - live.silentSince >= this.opts.silentAfterMs) {
          live.silentReported = true;
          events.push({ kind: 'silent', at: now, track, positionSec: live.positionSec });
        }
      } else {
        live.silentSince = null;
      }
    }

    const every = this.opts.noteMs;
    if (every > 0 && live.playing && now - live.lastNoteAt >= every) {
      live.lastNoteAt = now;
      events.push({ kind: 'note', at: now, track, positionSec: live.positionSec });
    }

    return events;
  }

  private positionOf(live: Live, now: number): number {
    const raw = live.playing ? live.positionSec + Math.max(0, (now - live.positionAt) / 1000) : live.positionSec;
    if (live.track.durationSec > 0) return Math.min(raw, live.track.durationSec);
    return Math.max(0, raw);
  }

  private handleAbsence(now: number, events: MusicEvent[]): void {
    const live = this.live;
    if (!live) return;
    if (this.awaySince === null) {
      this.awaySince = now;
      // 播放器消失前那一拍到现在的时间仍算在听，否则最后一段会被漏掉。
      if (live.playing) {
        live.playedMs += Math.max(0, now - live.lastTickAt);
        live.lastTickAt = now;
      }
    }
    if (now - this.awaySince < this.opts.endGraceMs) return;
    // 播放器停住时进度不发新值了，这一首听到哪算到哪。
    events.push({ kind: 'stopped', at: now, track: live.track, playedMs: live.playedMs });
    this.live = null;
    this.awaySince = null;
    this.pending = null;
  }
}

const ZERO_AUDIO: ProbeSnapshot['audio'] = {
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
