import { describe, expect, it } from 'vitest';
import { cleanTrackName, LyricsBook, lyricsViewAt, parseLrc, splitArtistTitle, type Lyrics } from '../src/lyrics.ts';

const LRC = [
  '[ti:Creep]',
  '[ar:Radiohead]',
  '[offset:0]',
  '[00:19.16] When you were here before',
  '[00:24.09] Couldn\'t look you in the eye',
  '[00:29.24] You\'re just like an angel',
  '[00:34.49][01:10.00] Your skin makes me cry',
].join('\n');

describe('parseLrc', () => {
  it('把每一行读成时间与文本，忽略元数据行', () => {
    const lines = parseLrc(LRC);
    expect(lines.map((l) => l.text)).toEqual([
      'When you were here before',
      'Couldn\'t look you in the eye',
      'You\'re just like an angel',
      'Your skin makes me cry',
      'Your skin makes me cry',
    ]);
    expect(lines[0].atMs).toBe(19_160);
    expect(lines[1].atMs).toBe(24_090);
  });

  it('一行挂多个时间标签时每个时间点各出一条', () => {
    const lines = parseLrc(LRC).filter((l) => l.text === 'Your skin makes me cry');
    expect(lines.map((l) => l.atMs)).toEqual([34_490, 70_000]);
  });

  it('三位小数按毫秒读，一位按百毫秒读', () => {
    expect(parseLrc('[00:01.5]a')[0].atMs).toBe(1_500);
    expect(parseLrc('[00:01.500]a')[0].atMs).toBe(1_500);
    expect(parseLrc('[00:01.05]a')[0].atMs).toBe(1_050);
  });

  it('offset 正值把整份歌词往后推', () => {
    const lines = parseLrc('[offset:250]\n[00:10.00]晚一点');
    expect(lines[0].atMs).toBe(10_250);
  });

  it('只有时间没有词的行是间奏标记，不产生歌词行', () => {
    expect(parseLrc('[00:05.00]\n[00:09.00]有词')).toHaveLength(1);
  });

  it('乱序的输入按时间排好', () => {
    const lines = parseLrc('[00:30.00]后\n[00:10.00]前');
    expect(lines.map((l) => l.text)).toEqual(['前', '后']);
  });

  it('不是 LRC 的纯文本返回空', () => {
    expect(parseLrc('just a line\nanother')).toHaveLength(0);
  });
});

describe('cleanTrackName', () => {
  it('去掉官方视频与 remaster 附注', () => {
    expect(cleanTrackName('Creep (Official Video)')).toBe('Creep');
    expect(cleanTrackName('Creep - Remastered 2011')).toBe('Creep');
    expect(cleanTrackName('Creep [2009 Remaster]')).toBe('Creep');
  });

  it('去掉 feat 段', () => {
    expect(cleanTrackName('Song (feat. Someone)')).toBe('Song');
  });

  it('认不出的原样返回', () => {
    expect(cleanTrackName('Bohemian Rhapsody')).toBe('Bohemian Rhapsody');
  });
});

describe('splitArtistTitle', () => {
  it('拆出「歌手 - 曲名」', () => {
    expect(splitArtistTitle('Radiohead - Creep')).toEqual({ artist: 'Radiohead', title: 'Creep' });
  });

  it('没有分隔符时返回 null', () => {
    expect(splitArtistTitle('Creep')).toBeNull();
  });
});

const lyrics: Lyrics = {
  timed: true,
  instrumental: false,
  lines: parseLrc(LRC),
  plain: '',
  matchedTitle: 'Creep',
  matchedArtist: 'Radiohead',
  rejected: '',
};

describe('lyricsViewAt', () => {
  it('给正在唱的那一行、上一行与下一行', () => {
    const view = lyricsViewAt(lyrics, 25);
    expect(view.current).toBe('Couldn\'t look you in the eye');
    expect(view.previous).toBe('When you were here before');
    expect(view.upcoming).toBe('You\'re just like an angel');
    expect(view.upcomingInSec).toBeCloseTo(4.2, 1);
  });

  it('还没开口时没有正在唱的行，下一行是第一句', () => {
    const view = lyricsViewAt(lyrics, 3);
    expect(view.current).toBe('');
    expect(view.upcoming).toBe('When you were here before');
  });

  it('唱完最后一行后没有下一句', () => {
    const view = lyricsViewAt(lyrics, 200);
    expect(view.current).toBe('Your skin makes me cry');
    expect(view.upcoming).toBe('');
    expect(view.linesRemaining).toBe(0);
  });

  it('剩余行数按当前行之后还有几句算', () => {
    expect(lyricsViewAt(lyrics, 20).linesRemaining).toBe(4);
  });

  it('没有时间轴的歌词不做对齐', () => {
    const view = lyricsViewAt({ ...lyrics, timed: false, lines: [] }, 42);
    expect(view).toMatchObject({ current: '', upcoming: '', timed: false });
  });
});

describe('LyricsBook', () => {
  const track = { key: 'k', title: 't', artist: 'a', album: '', app: '', durationSec: 0 };

  it('同一首歌只发一次请求，成功与失败都缓存', async () => {
    let calls = 0;
    // 假的取词：不发网络请求，只数被调用了几次。
    const book = new LyricsBook(64, async () => {
      calls += 1;
      return null;
    });
    const first = book.get(track);
    const second = book.get(track);
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  it('forget 之后重新取', async () => {
    let calls = 0;
    const book = new LyricsBook(64, async () => {
      calls += 1;
      return null;
    });
    const a = book.get(track);
    book.forget('k');
    const b = book.get(track);
    expect(a).not.toBe(b);
    await Promise.all([a, b]);
    expect(calls).toBe(2);
  });

  it('取词抛错时当成没有歌词，而不是把异常抛给调用方', async () => {
    const book = new LyricsBook(64, async () => {
      throw new Error('boom');
    });
    await expect(book.get(track)).resolves.toBeNull();
  });
});
