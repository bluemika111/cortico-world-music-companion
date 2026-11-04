/**
 * 歌词：向 LRCLIB 要来一首歌的时间轴文本，再按此刻的播放进度切出"正在唱的这句"。
 *
 * LRCLIB 是开放歌词库，不需要账号。网络失败、找不到、只有纯文本都能正常走完：
 * 歌词是可选的增强，缺了不影响这一 World 报出歌名与听感。
 */
import type { LyricLine, LyricsView, TrackIdentity } from './types.ts';
import { sanitizeLyrics } from './sanitize.ts';

const LRCLIB_BASE = 'https://lrclib.net/api';
const USER_AGENT = 'cortico-world-music/0.1 (https://github.com/Pal-AI-Lab/cortico-extensions)';
const REQUEST_TIMEOUT_MS = 8_000;

/** 一份取到的歌词。timed 为假时只有 plain，歌词不参与对齐。 */
export interface Lyrics {
  timed: boolean;
  instrumental: boolean;
  /** 有时间轴的行，按 atMs 升序，已过白名单检查。无时间轴时为空数组。 */
  lines: LyricLine[];
  /** 纯文本全文；只留作诊断，不进正文。 */
  plain: string;
  /** LRCLIB 上的曲名与歌手，用来发现匹配偏差。 */
  matchedTitle: string;
  matchedArtist: string;
  /** 整份歌词为什么被拒；空串表示可用。 */
  rejected: string;
}

interface LrclibRecord {
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

/** 时间标签：[mm:ss]、[mm:ss.xx]、[mm:ss.xxx]，也认 [hh:mm:ss.xx]。 */
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG = /^\[(ar|ti|al|by|au|length|offset|re|ve):(.*)\]$/i;

/**
 * 解析 LRC。一行可以挂多个时间标签，同一个文本会出现在每个时间点上。
 * `[offset:n]` 按 LRCLIB 的惯例处理：正值表示歌词要往后推。
 */
export function parseLrc(raw: string): LyricLine[] {
  const text = raw.replace(/\r\n?/g, '\n');
  let offsetMs = 0;
  for (const line of text.split('\n')) {
    const meta = META_TAG.exec(line.trim());
    if (meta && meta[1].toLowerCase() === 'offset') {
      const value = Number.parseInt(meta[2].trim(), 10);
      if (Number.isFinite(value)) offsetMs = value;
    }
  }

  const out: LyricLine[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (META_TAG.test(trimmed)) continue;

    const stamps: number[] = [];
    TIME_TAG.lastIndex = 0;
    let match = TIME_TAG.exec(trimmed);
    let consumed = 0;
    while (match && match.index === consumed) {
      const minutes = Number.parseInt(match[1], 10);
      const seconds = Number.parseInt(match[2], 10);
      const fraction = match[3] ?? '0';
      // 两位是厘秒，三位是毫秒。
      const millis = fraction.length === 1
        ? Number.parseInt(fraction, 10) * 100
        : Number.parseInt(fraction.padEnd(3, '0').slice(0, 3), 10);
      stamps.push(minutes * 60_000 + seconds * 1_000 + millis);
      consumed = match.index + match[0].length;
      match = TIME_TAG.exec(trimmed);
    }
    if (stamps.length === 0) continue;

    const body = trimmed.slice(consumed).trim();
    if (!body) continue; // 只有时间、没有词的行是间奏标记，对齐时不需要
    for (const atMs of stamps) out.push({ atMs: Math.max(0, atMs + offsetMs), text: body });
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}

/**
 * 把 SMTC 给的标题洗成搜索用的曲名：去掉 `(feat. …)`、`- Remastered 2011`、
 * `[Official Video]` 这类附注。洗不动就原样返回，让 LRCLIB 自己决定匹配不上。
 */
export function cleanTrackName(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  // YouTube 与部分播放器把 "歌手 - 曲名" 塞进标题。
  s = s.replace(/\s*[([]\s*(?:official|lyrics?|audio|video|music\s*video|hd|hq|mv|m\/v)[^)\]]*[)\]]/gi, '');
  s = s.replace(/\s*[([]\s*(?:feat\.?|ft\.?|with)\s[^)\]]*[)\]]/gi, '');
  s = s.replace(/\s*[([]\s*(?:remaster(?:ed)?|live|radio\s*edit|acoustic|demo|mono|stereo)[^)\]]*[)\]]/gi, '');
  s = s.replace(/\s+-\s+(?:remaster(?:ed)?|live|radio\s*edit|acoustic|demo|mono|stereo)\b.*$/i, '');
  s = s.replace(/\s*[([]\s*\d{4}\s*(?:remaster(?:ed)?)?[)\]]/gi, '');
  return s.replace(/\s{2,}/g, ' ').trim();
}

/** 从 `Artist - Title` 形态里拆出歌手；拆不出时返回 null。 */
export function splitArtistTitle(raw: string): { artist: string; title: string } | null {
  const index = raw.indexOf(' - ');
  if (index <= 0) return null;
  const artist = raw.slice(0, index).trim();
  const title = raw.slice(index + 3).trim();
  if (!artist || !title) return null;
  return { artist, title };
}

function toLyrics(record: LrclibRecord): Lyrics | null {
  const synced = typeof record.syncedLyrics === 'string' ? record.syncedLyrics : '';
  const plain = typeof record.plainLyrics === 'string' ? record.plainLyrics : '';
  const base = {
    matchedTitle: record.trackName ?? '',
    matchedArtist: record.artistName ?? '',
  };
  if (!synced && !plain) {
    if (record.instrumental !== true) return null;
    return { ...base, timed: false, instrumental: true, lines: [], plain: '', rejected: '' };
  }
  const parsed = synced ? parseLrc(synced) : [];
  // 歌词是公网数据：进来的那一刻就过白名单，之后一路都用干净的这份。
  const checked = sanitizeLyrics(parsed);
  return {
    ...base,
    timed: checked.lines.length > 0,
    instrumental: record.instrumental === true,
    lines: checked.lines,
    plain,
    rejected: checked.rejected,
  };
}

async function getJson(path: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${LRCLIB_BASE}${path}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function durationMatches(record: LrclibRecord, durationSec: number): boolean {
  if (!durationSec || typeof record.duration !== 'number' || !record.duration) return true;
  return Math.abs(record.duration - durationSec) <= 8;
}

/**
 * 查一首歌的歌词。先按曲名+歌手+时长精确要一份；要不到再搜一轮，
 * 从结果里挑时长最接近的那条。任何一步失败都返回 null。
 */
export async function fetchLyrics(track: TrackIdentity): Promise<Lyrics | null> {
  const title = cleanTrackName(track.title) || track.title;
  const artist = cleanTrackName(track.artist) || track.artist;
  if (!title) return null;

  const exact = new URLSearchParams({ track_name: title });
  if (artist) exact.set('artist_name', artist);
  if (track.album) exact.set('album_name', cleanTrackName(track.album) || track.album);
  if (track.durationSec > 0) exact.set('duration', String(Math.round(track.durationSec)));

  const direct = await getJson(`/get?${exact.toString()}`);
  if (direct && typeof direct === 'object') {
    const lyrics = toLyrics(direct as LrclibRecord);
    if (lyrics) return lyrics;
  }

  const search = new URLSearchParams({ track_name: title });
  if (artist) search.set('artist_name', artist);
  const found = await getJson(`/search?${search.toString()}`);
  if (!Array.isArray(found) || found.length === 0) return null;

  const scored = (found as LrclibRecord[])
    .filter((record) => durationMatches(record, track.durationSec))
    .map((record) => {
      const lyrics = toLyrics(record);
      if (!lyrics) return null;
      // 同步歌词优先；时长越接近越好。
      const gap = track.durationSec && typeof record.duration === 'number'
        ? Math.abs((record.duration ?? 0) - track.durationSec)
        : 0;
      return { lyrics, score: (lyrics.timed ? 0 : 1000) + gap };
    })
    .filter((entry): entry is { lyrics: Lyrics; score: number } => entry !== null)
    .sort((a, b) => a.score - b.score);

  return scored[0]?.lyrics ?? null;
}

/**
 * 当前这一段：正在唱的那一句，加上后面 `ahead` 句。总量由 LIMITS.lyricWindow 封顶——
 * 正文只放当前附近，本来就不该给整首歌。
 */
export function lyricWindowAt(
  lyrics: Lyrics,
  positionSec: number,
  ahead: number,
): Array<{ text: string; offsetSec: number | null }> {
  if (!lyrics.timed || lyrics.lines.length === 0) return [];
  const limit = Math.max(1, Math.min(ahead + 1, 6));
  const positionMs = Math.max(0, positionSec * 1000);

  let low = 0;
  let high = lyrics.lines.length - 1;
  let index = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lyrics.lines[mid].atMs <= positionMs) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const start = index >= 0 ? index : 0;
  const rows: Array<{ text: string; offsetSec: number | null }> = [];
  for (let i = start; i < lyrics.lines.length && rows.length < limit; i += 1) {
    const line = lyrics.lines[i];
    rows.push({
      text: line.text,
      // 当前这一句已经在唱，给相对时间只会让人困惑。
      offsetSec: i === start ? null : Math.round((line.atMs - positionMs) / 100) / 10,
    });
  }
  return rows;
}

/** 按播放进度切出正在唱、刚唱过、接下来要唱的三行。 */
export function lyricsViewAt(lyrics: Lyrics, positionSec: number): LyricsView {
  const empty: LyricsView = {
    current: '',
    previous: '',
    upcoming: '',
    upcomingInSec: null,
    linesRemaining: 0,
    timed: lyrics.timed,
  };
  if (!lyrics.timed || lyrics.lines.length === 0) return empty;

  const positionMs = Math.max(0, positionSec * 1000);
  const lines = lyrics.lines;

  // 最后一行 atMs <= positionMs 的下标；一首歌还没开始唱时是 -1。
  let low = 0;
  let high = lines.length - 1;
  let index = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].atMs <= positionMs) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const nextIndex = index + 1;
  const next = nextIndex < lines.length ? lines[nextIndex] : null;
  return {
    current: index >= 0 ? lines[index].text : '',
    previous: index >= 1 ? lines[index - 1].text : '',
    upcoming: next ? next.text : '',
    upcomingInSec: next ? Math.max(0, Math.round((next.atMs - positionMs) / 100) / 10) : null,
    linesRemaining: Math.max(0, lines.length - (index + 1)),
    timed: true,
  };
}

/**
 * 同一首歌只用一份歌词。缓存按 key 记住 promise，同时到达的两次查询不会各发一轮请求；
 * 失败也缓存，免得一首找不到的歌每拍都去打一次网络。
 */
export class LyricsBook {
  private readonly cache = new Map<string, Promise<Lyrics | null>>();
  private readonly limit: number;
  private readonly fetcher: (track: TrackIdentity) => Promise<Lyrics | null>;

  constructor(limit = 64, fetcher: (track: TrackIdentity) => Promise<Lyrics | null> = fetchLyrics) {
    this.limit = limit;
    this.fetcher = fetcher;
  }

  get(track: TrackIdentity): Promise<Lyrics | null> {
    const existing = this.cache.get(track.key);
    if (existing) return existing;
    const pending = this.fetcher(track).catch(() => null);
    this.cache.set(track.key, pending);
    if (this.cache.size > this.limit) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    return pending;
  }

  forget(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}
