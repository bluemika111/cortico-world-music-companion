import { describe, expect, it } from 'vitest';
import {
  isVerdict,
  latestByTrack,
  parseTaste,
  renderFeelReceipt,
  renderTaste,
  renderTasteMemory,
  type TasteEntry,
} from '../src/taste.ts';

const track = {
  key: 'spotify.exe|creep|radiohead',
  title: 'Creep',
  artist: 'Radiohead',
  album: 'Pablo Honey',
  app: 'spotify.exe',
  durationSec: 239,
};

function entry(overrides: Partial<TasteEntry> = {}): TasteEntry {
  return {
    at: '2026-11-18T12:00:00.000Z',
    track: 'spotify.exe|creep|radiohead',
    title: 'Creep',
    artist: 'Radiohead',
    verdict: 'like',
    note: '',
    ...overrides,
  };
}

describe('parseTaste', () => {
  it('读出一行完整记录', () => {
    const parsed = parseTaste(JSON.stringify(entry({ note: '前奏一响就想起高二' })));
    expect(parsed).toMatchObject({ verdict: 'like', note: '前奏一响就想起高二' });
  });

  it('缺曲目或缺时刻的行丢掉', () => {
    expect(parseTaste(JSON.stringify({ ...entry(), track: '' }))).toBeNull();
    expect(parseTaste(JSON.stringify({ ...entry(), at: '' }))).toBeNull();
  });

  it('态度不是 like/dislike 的行丢掉', () => {
    expect(parseTaste(JSON.stringify({ ...entry(), verdict: 'meh' }))).toBeNull();
  });

  it('坏 JSON 与空行丢掉', () => {
    expect(parseTaste('{not json')).toBeNull();
    expect(parseTaste('   ')).toBeNull();
  });
});

describe('latestByTrack', () => {
  it('同一首取最新的一条', () => {
    const map = latestByTrack([
      entry({ at: '2026-11-01T00:00:00.000Z', verdict: 'dislike' }),
      entry({ at: '2026-11-10T00:00:00.000Z', verdict: 'like', note: '后来听懂了' }),
    ]);
    expect(map.get(track.key)?.verdict).toBe('like');
    expect(map.get(track.key)?.note).toBe('后来听懂了');
  });

  it('不同曲目各留一条', () => {
    const map = latestByTrack([entry(), entry({ track: 'other', title: 'Other' })]);
    expect(map.size).toBe(2);
  });
});

describe('renderTasteMemory', () => {
  it('把以前说过的话原样递回去', () => {
    const text = renderTasteMemory({ verdict: 'like', note: '前奏一响就想起高二', at: '' });
    expect(text).toContain('喜欢');
    expect(text).toContain('前奏一响就想起高二');
  });

  it('只表态没写字时只说态度', () => {
    expect(renderTasteMemory({ verdict: 'dislike', note: '', at: '' })).toBe('你以前对这首说过：不太喜欢');
  });

  it('没说过就什么都不给', () => {
    expect(renderTasteMemory(null)).toBe('');
  });
});

describe('renderFeelReceipt', () => {
  it('确认写下了什么', () => {
    const text = renderFeelReceipt(track, 'like', '好听', 1);
    expect(text).toContain('Radiohead《Creep》');
    expect(text).toContain('喜欢');
    expect(text).toContain('好听');
  });

  it('重复表态时说明会覆盖', () => {
    expect(renderFeelReceipt(track, 'like', '', 3)).toContain('第 3 次');
  });
});

describe('renderTaste', () => {
  it('分开列喜欢与不喜欢，并按歌手汇总', () => {
    const text = renderTaste({
      liked: [entry({ title: 'Creep', note: '好听' }), entry({ track: 'b', title: 'High and Dry' })],
      disliked: [entry({ track: 'c', title: 'Fake Plastic Trees', verdict: 'dislike' })],
      artists: [{ name: 'Radiohead', liked: 2, disliked: 1 }],
      total: 3,
    }, 30);
    expect(text).toContain('共 3 首');
    expect(text).toContain('Creep（好听）');
    expect(text).toContain('不太喜欢');
    expect(text).toContain('Radiohead 2 首');
  });

  it('一条都没有时直说，并指出怎么记', () => {
    const text = renderTaste({ liked: [], disliked: [], artists: [], total: 0 }, 30);
    expect(text).toContain('还没有对任何一首歌表过态');
    expect(text).toContain('music_feel');
  });
});

describe('isVerdict', () => {
  it('只认两个值', () => {
    expect(isVerdict('like')).toBe(true);
    expect(isVerdict('dislike')).toBe(true);
    expect(isVerdict('meh')).toBe(false);
    expect(isVerdict(undefined)).toBe(false);
  });
});
