/**
 * 外部文本的白名单与形状检查。
 *
 * 歌名、歌手、专辑与歌词都不是这台机器算出来的：前三个由播放器自己上报，后一个来自公网歌词库。
 * 它们只能当数据用。这里的职责只有三件：剥掉不可见与重排字符、卡住长度、在形状异常时拒绝，
 * 好让上游据此**降级**（少给一段），而不是把可疑内容交给模型。
 *
 * 判据全部是结构性的：长度、字符类别、替换比例。不做关键词匹配——那既误伤又只覆盖一种语言。
 */
import type { LyricLine } from './types.ts';

/** 进入正文的外部文本各能有多长。超出的元数据整段不用，超出的歌词行只丢那一行。 */
export const LIMITS = {
  title: 160,
  artist: 160,
  album: 160,
  app: 160,
  /** 一行歌词。中文一行通常不到 30 字，160 已经宽得离谱。 */
  lyricLine: 160,
  /** 整份歌词的行数上限；超过说明这不像歌词。 */
  lyricLines: 400,
  /** 正文里一次最多给几句歌词（当前这一句加上后面几句）。 */
  lyricWindow: 3,
} as const;

/** C0/C1 控制字符。换行单独处理，不在这里。 */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** 双向控制字符与零宽填充：能把一段文字在视觉上重排，或藏起内容。 */
const INVISIBLE = /[\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
/** 行/段分隔符：能把单行撑成两行，破坏「这一段是数据」的边界。 */
const SEPARATORS = /[\u2028\u2029]/g;
const ANY_BREAK = /[\r\n\t]+/g;

/** 一条外部文本的检查结果。rejected 非空时 text 是空串，调用方据此降级。 */
export interface CheckedText {
  text: string;
  rejected: string;
}

/** 形状异常时整份歌词不用。 */
export function sanitizeLyrics(lines: LyricLine[]): { lines: LyricLine[]; rejected: string } {
  if (lines.length === 0) return { lines: [], rejected: '' };
  if (lines.length > LIMITS.lyricLines) {
    return { lines: [], rejected: `行数 ${lines.length} 不像歌词` };
  }
  const out: LyricLine[] = [];
  let dropped = 0;
  for (const line of lines) {
    const checked = checkText(line.text, LIMITS.lyricLine);
    if (!checked.text) {
      dropped += 1;
      continue;
    }
    out.push({ atMs: line.atMs, text: checked.text });
  }
  // 大多数行都被丢掉时，剩下的几句也不足以为凭。
  if (dropped > lines.length / 2) {
    return { lines: [], rejected: `${dropped}/${lines.length} 行的形状异常` };
  }
  return { lines: out, rejected: '' };
}

/**
 * 净化一条单行文本：剥掉控制与不可见字符、把内部换行折成空格、收紧空白，再卡长度。
 * 返回值里 text 为空表示这条文本不能用。
 */
export function checkText(raw: string, limit: number): CheckedText {
  if (typeof raw !== 'string') return { text: '', rejected: 'not text' };
  const trimmed = raw.trim();
  if (!trimmed) return { text: '', rejected: '' };

  const cleaned = trimmed
    .replace(CONTROL, '')
    .replace(INVISIBLE, '')
    .replace(SEPARATORS, ' ')
    .replace(ANY_BREAK, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!cleaned) return { text: '', rejected: '只有不可见字符' };

  // 大比例字符被剥掉，说明原文不是正常写出来的文本。
  const removed = trimmed.length - cleaned.length;
  if (trimmed.length >= 8 && removed / trimmed.length > 0.25) {
    return { text: '', rejected: '不可见字符过多' };
  }

  if (cleaned.length > limit) {
    return { text: '', rejected: `超过 ${limit} 字符` };
  }

  return { text: cleaned, rejected: '' };
}

/** 正文里给出去的文本再收一道：换行一律折平，免得伪造下一段的结构。 */
export function inlineText(text: string, limit: number): string {
  return checkText(text, limit).text;
}
