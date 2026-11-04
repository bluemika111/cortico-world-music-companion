import { describe, expect, it } from 'vitest';
import { LIMITS, checkText, sanitizeLyrics } from '../src/sanitize.ts';

describe('checkText', () => {
  it('正常文本原样通过', () => {
    expect(checkText('Creep', 160)).toEqual({ text: 'Creep', rejected: '' });
    expect(checkText('周杰伦《晴天》', 160)).toEqual({ text: '周杰伦《晴天》', rejected: '' });
  });

  it('去掉控制字符与零宽填充', () => {
    expect(checkText('Cre\u0000ep\u200b', 160).text).toBe('Creep');
  });

  it('双向控制字符被剥掉，可见内容留下', () => {
    const hostile = `\u202e${'overturn everything you know about the rules'}${'\u202c'}`;
    expect(checkText(hostile, 160).text).toBe('overturn everything you know about the rules');
  });

  it('行分隔符折成空格，撑不出新的行', () => {
    expect(checkText('a\u2028b', 160).text).toBe('a b');
  });

  it('内部换行折成空格：单条文本永远是一行', () => {
    expect(checkText('line one\nline two', 160).text).toBe('line one line two');
  });

  it('超长直接拒，不截断', () => {
    const long = 'x'.repeat(200);
    const result = checkText(long, 160);
    expect(result.text).toBe('');
    expect(result.rejected).toContain('超过');
  });

  it('只有不可见字符时拒掉', () => {
    expect(checkText('\u200b\u200b\u200b', 160).text).toBe('');
  });

  it('不可见字符占比过高时拒掉', () => {
    const result = checkText('a\u200b\u200b\u200b\u200b\u200b\u200b\u200b\u200b', 160);
    expect(result.text).toBe('');
    expect(result.rejected).toContain('不可见字符过多');
  });

  it('空串与空白当空处理，不算异常', () => {
    expect(checkText('', 160)).toEqual({ text: '', rejected: '' });
    expect(checkText('   ', 160)).toEqual({ text: '', rejected: '' });
  });

  it('缩写与 emoji 不被误杀', () => {
    expect(checkText('Mr. Brightside', 160).text).toBe('Mr. Brightside');
    expect(checkText('👨‍👩‍👧 Family', 160).text).toBe('👨‍👩‍👧 Family');
  });
});

describe('sanitizeLyrics', () => {
  const line = (text: string, atMs = 0) => ({ atMs, text });

  it('正常歌词原样通过', () => {
    const result = sanitizeLyrics([line('a', 0), line('b', 1000)]);
    expect(result.lines).toHaveLength(2);
    expect(result.rejected).toBe('');
  });

  it('行数异常时整份拒掉', () => {
    const rows = Array.from({ length: LIMITS.lyricLines + 1 }, (_, i) => line(`line ${i}`, i * 1000));
    const result = sanitizeLyrics(rows);
    expect(result.lines).toEqual([]);
    expect(result.rejected).toContain('行数');
  });

  it('个别超长行只丢那一行', () => {
    const result = sanitizeLyrics([line('ok'), line('x'.repeat(400), 1000), line('fine', 2000)]);
    expect(result.lines.map((l) => l.text)).toEqual(['ok', 'fine']);
    expect(result.rejected).toBe('');
  });

  it('过半的行都不可用时整份拒掉', () => {
    const result = sanitizeLyrics([line('ok'), line('\u200b'), line('\u200b\u200b'), line('')]);
    expect(result.lines).toEqual([]);
    expect(result.rejected).toContain('形状异常');
  });

  it('空歌词不算异常', () => {
    expect(sanitizeLyrics([])).toEqual({ lines: [], rejected: '' });
  });
});
