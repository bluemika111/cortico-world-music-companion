/**
 * 她自己的音乐口味。
 *
 * 这里只做机械记录：存的是她亲口说过的话，World 不推断、不评分、不替她总结成性格。
 * 「喜欢」与「不喜欢」由她自己判断，一句感受也由她自己写；这个模块只负责把它们
 * 按歌归并、去重、取最新，并在下一次听到同一首时原样递回去。
 */
import type { TrackIdentity } from './types.ts';

/** 她对一首歌的态度。只有两种明确表态；说不上来时用 note 承载，不另外设档。 */
export type Verdict = 'like' | 'dislike';

export const VERDICTS: readonly Verdict[] = ['like', 'dislike'];

/** 她写下来的一条。note 是她自己的话，可能为空。 */
export interface TasteEntry {
  /** ISO 时刻。 */
  at: string;
  /** 曲目 key，与 watcher 用的是同一个。 */
  track: string;
  title: string;
  artist: string;
  verdict: Verdict;
  note: string;
}

/** 一首歌上最近一次表态。 */
export interface TasteView {
  verdict: Verdict;
  note: string;
  at: string;
}

export function isVerdict(value: unknown): value is Verdict {
  return value === 'like' || value === 'dislike';
}

/** 从记录文件的一行里读出条目；形状不对就丢掉，不猜。 */
export function parseTaste(line: string): TasteEntry | null {
  if (!line.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const track = typeof row.track === 'string' ? row.track : '';
  const at = typeof row.at === 'string' ? row.at : '';
  if (!track || !at) return null;
  if (!isVerdict(row.verdict)) return null;
  return {
    at,
    track,
    title: typeof row.title === 'string' ? row.title : '',
    artist: typeof row.artist === 'string' ? row.artist : '',
    verdict: row.verdict,
    note: typeof row.note === 'string' ? row.note : '',
  };
}

/** 按曲目取最近一次表态。后写的覆盖先写的。 */
export function latestByTrack(entries: readonly TasteEntry[]): Map<string, TasteEntry> {
  const out = new Map<string, TasteEntry>();
  for (const entry of entries) {
    const existing = out.get(entry.track);
    if (!existing || entry.at >= existing.at) out.set(entry.track, entry);
  }
  return out;
}

/** 事件正文用：她自己以前说过的那一句，连同态度。 */
export function renderTasteMemory(view: TasteView | null): string {
  if (!view) return '';
  const stance = view.verdict === 'like' ? '喜欢' : '不太喜欢';
  const note = view.note ? `，说「${view.note}」` : '';
  return `你以前对这首说过：${stance}${note}`;
}

/** `music_feel` 的回执：确认写下了什么，并说明这是第几次。 */
export function renderFeelReceipt(
  track: TrackIdentity,
  verdict: Verdict,
  note: string,
  seenBefore: number,
): string {
  const name = track.artist ? `${track.artist}《${track.title}》` : `《${track.title}》`;
  const stance = verdict === 'like' ? '喜欢' : '不太喜欢';
  const mine = note ? `，写下的是「${note}」` : '';
  const repeat = seenBefore > 1 ? `这是你第 ${seenBefore} 次对这首表态，新的说法覆盖旧的。` : '';
  return `记下了：你对 ${name} ${stance}${mine}。${repeat}`.trim();
}

/** `music_taste` 的回执：她的口味档案，只列她明确表过态的歌。 */
export function renderTaste(summary: {
  liked: TasteEntry[];
  disliked: TasteEntry[];
  artists: Array<{ name: string; liked: number; disliked: number }>;
  total: number;
}, days: number): string {
  if (summary.total === 0) {
    return `最近 ${days} 天里，你还没有对任何一首歌表过态。遇到想记的，用 music_feel 记一句。`;
  }

  const lines: string[] = [`最近 ${days} 天你表过态的歌共 ${summary.total} 首。`];

  if (summary.liked.length > 0) {
    const rows = summary.liked
      .slice(0, 8)
      .map((e) => (e.note ? `${e.title}（${e.note}）` : e.title))
      .join('、');
    lines.push(`你说喜欢的：${rows}。`);
  }
  if (summary.disliked.length > 0) {
    const rows = summary.disliked.slice(0, 8).map((e) => e.title).join('、');
    lines.push(`你说不太喜欢的：${rows}。`);
  }

  const loving = summary.artists.filter((a) => a.liked > 0).sort((a, b) => b.liked - a.liked).slice(0, 5);
  if (loving.length > 0) {
    lines.push(`按歌手算：${loving.map((a) => `${a.name} ${a.liked} 首`).join('、')}。`);
  }

  return lines.join('\n');
}
