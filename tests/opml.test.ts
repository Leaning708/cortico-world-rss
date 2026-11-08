import { describe, expect, it } from 'vitest';
import { exportOpml, parseOpml } from '../src/opml.ts';
import type { FeedRecord } from '../src/store.ts';

function fakeFeed(overrides: Partial<FeedRecord>): FeedRecord {
  return {
    id: 'f_1', url: 'https://a.com/feed', title: 'A 源', notify: 'notify', intervalMinutes: 0,
    include: [], exclude: [], paused: false, weight: 1, userAgent: '', allowPrivate: false, fullText: true, createdAt: '2026-11-01T00:00:00Z',
    etag: null, lastModified: null, lastFetchAt: null, lastOkAt: null, lastError: null,
    consecutiveErrors: 0, nextPollAt: null, backoffIndex: 0, seenKeys: [],
    ...overrides,
  };
}

describe('opml', () => {
  it('导出后可回读,字段一致', () => {
    const feeds = [
      fakeFeed({ id: 'f_1', url: 'https://a.com/feed', title: 'A & B <源>' }),
      fakeFeed({ id: 'f_2', url: 'https://b.com/atom.xml', title: 'B 源' }),
    ];
    const xml = exportOpml(feeds);
    const entries = parseOpml(xml);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ url: 'https://a.com/feed', title: 'A & B <源>' });
    expect(entries[1].url).toBe('https://b.com/atom.xml');
  });

  it('导入标准 OPML:递归 outline,按 URL 去重', () => {
    const xml = `<?xml version="1.0"?><opml version="2.0"><head><title>x</title></head><body>
      <outline text="分类">
        <outline type="rss" text="源一" xmlUrl="https://x.com/feed"/>
        <outline type="rss" text="源一重复" xmlUrl="https://x.com/feed"/>
      </outline>
      <outline type="rss" text="源二" xmlUrl="https://y.com/rss"/>
      <outline text="不是源,没有 xmlUrl"/>
    </body></opml>`;
    const entries = parseOpml(xml);
    expect(entries).toEqual([
      { url: 'https://x.com/feed', title: '源一' },
      { url: 'https://y.com/rss', title: '源二' },
    ]);
  });

  it('标题回落 text,再回落 url;非 OPML 抛错,残缺标签容错为空', () => {
    const entries = parseOpml('<opml><body><outline xmlUrl="https://z.com/f"/></body></opml>');
    expect(entries[0].title).toBe('https://z.com/f');
    expect(() => parseOpml('这是普通文本,不是 XML')).toThrow(/OPML/);
    expect(parseOpml('<opml><body>')).toEqual([]);
  });

  it('空订阅导出仍是合法 OPML', () => {
    expect(parseOpml(exportOpml([]))).toEqual([]);
  });
});
