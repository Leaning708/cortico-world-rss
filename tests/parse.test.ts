import { describe, expect, it } from 'vitest';
import { decodeEntities, discoverFeedsInHtml, hashUid, parseFeed, ParseError, stripHtml } from '../src/parse.ts';

const RSS20 = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>阮一峰的网络日志</title>
    <link>https://www.ruanyifeng.com/blog/</link>
    <description>科技爱好者周刊</description>
    <item>
      <guid isPermaLink="false">urn:blog:420</guid>
      <title>科技爱好者周刊(第 420 期):本地优先软件</title>
      <link>https://www.ruanyifeng.com/blog/2026/11/weekly-issue-420.html</link>
      <pubDate>Fri, 06 Nov 2026 02:00:00 GMT</pubDate>
      <description>&lt;p&gt;这里记录每周值得分享的内容,&lt;b&gt;加粗&lt;/b&gt;要剥掉。&lt;/p&gt;</description>
      <content:encoded><![CDATA[<p>全文内容 <em>带标签</em></p>]]></content:encoded>
    </item>
    <item>
      <guid isPermaLink="false">urn:blog:419</guid>
      <title>上一期</title>
      <link>https://www.ruanyifeng.com/blog/2026/10/weekly-issue-419.html</link>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Hacker News</title>
  <link rel="alternate" href="https://news.ycombinator.com/"/>
  <link rel="self" href="https://news.ycombinator.com/rss"/>
  <entry>
    <id>urn:hn:1</id>
    <title>Show HN: I built a tiny RSS-to-Email service</title>
    <link rel="alternate" href="https://news.ycombinator.com/item?id=1"/>
    <published>2026-11-06T08:00:00Z</published>
    <summary>Plain text summary with &amp; entity.</summary>
  </entry>
  <entry>
    <id>urn:hn:2</id>
    <title>Second entry</title>
    <link href="https://news.ycombinator.com/item?id=2"/>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
  <channel rdf:about="https://example.org/">
    <title>RDF 源</title>
  </channel>
  <item rdf:about="https://example.org/a">
    <title>第一条</title>
    <link>https://example.org/a</link>
    <dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">2026-11-06T01:00:00Z</dc:date>
  </item>
</rdf:RDF>`;

describe('parseFeed', () => {
  it('解析 RSS 2.0:title 剥标签、description 解实体、content:encoded 保留原文', () => {
    const feed = parseFeed(RSS20);
    expect(feed.title).toBe('阮一峰的网络日志');
    expect(feed.link).toBe('https://www.ruanyifeng.com/blog/');
    expect(feed.items).toHaveLength(2);
    const first = feed.items[0];
    expect(first.uid).toBe('urn:blog:420');
    expect(first.title).toBe('科技爱好者周刊(第 420 期):本地优先软件');
    expect(first.description).toContain('加粗');
    expect(first.description).not.toContain('<b>');
    expect(first.contentHtml).toContain('<p>全文内容 <em>带标签</em></p>');
    expect(first.publishedAt).toBe('2026-11-06T02:00:00.000Z');
    expect(first.url).toBe('https://www.ruanyifeng.com/blog/2026/11/weekly-issue-420.html');
  });

  it('解析 Atom:优先 rel=alternate 链接', () => {
    const feed = parseFeed(ATOM);
    expect(feed.title).toBe('Hacker News');
    expect(feed.items[0].uid).toBe('urn:hn:1');
    expect(feed.items[0].url).toBe('https://news.ycombinator.com/item?id=1');
    expect(feed.items[0].description).toContain('& entity');
    expect(feed.items[1].url).toBe('https://news.ycombinator.com/item?id=2');
  });

  it('解析 RDF(RSS 1.0):item 在根层级', () => {
    const feed = parseFeed(RDF);
    expect(feed.title).toBe('RDF 源');
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].url).toBe('https://example.org/a');
    expect(feed.items[0].publishedAt).toBe('2026-11-06T01:00:00.000Z');
  });

  it('去重键三级回落:guid > link > hash', () => {
    const feed = parseFeed(RSS20);
    expect(feed.items[1].uid).toBe('urn:blog:419');
    const hashFeed = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title>无链接</title><description>描述</description></item></channel></rss>`);
    expect(hashFeed.items[0].uid).toBe(hashUid('无链接\u0000描述'));
  });

  it('enclosure 解析', () => {
    const feed = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title>播客</title><enclosure url="https://x.com/a.mp3" type="audio/mpeg"/></item></channel></rss>`);
    expect(feed.items[0].enclosure).toEqual({ mime: 'audio/mpeg', url: 'https://x.com/a.mp3' });
  });

  it('畸形输入抛 ParseError', () => {
    expect(() => parseFeed('这不是 XML')).toThrow(ParseError);
    expect(() => parseFeed('<html><body>页面</body></html>')).toThrow(ParseError);
    expect(() => parseFeed('<rss version="2.0"><channel></channel></rss>')).toThrow(ParseError);
  });

  it('非法日期回落 null', () => {
    const feed = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title>x</title><pubDate>not-a-date</pubDate></item></channel></rss>`);
    expect(feed.items[0].publishedAt).toBeNull();
  });
});

describe('stripHtml / decodeEntities / hashUid', () => {
  it('块级标签转换行,空白折叠', () => {
    expect(stripHtml('<p>第一段</p><p>第二段</p>')).toBe('第一段\n第二段');
  });
  it('命名与数字实体', () => {
    expect(decodeEntities('a &amp; b &#x4e2d; &#20013; &mdash; &unknown;')).toBe('a & b 中 中 — &unknown;');
  });
  it('script/style 整块删除', () => {
    expect(stripHtml('<script>alert(1)</script>正文<style>p{}</style>')).toBe('正文');
  });
  it('hashUid 稳定', () => {
    expect(hashUid('abc')).toBe(hashUid('abc'));
    expect(hashUid('abc')).not.toBe(hashUid('abd'));
  });
});

describe('discoverFeedsInHtml', () => {
  it('找 link rel=alternate 并解析相对地址', () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
      <link rel="alternate" type="application/atom+xml" href="https://cdn.example.org/atom.xml">
      <link rel="stylesheet" href="/style.css">
    </head><body></body></html>`;
    const found = discoverFeedsInHtml(html, 'https://example.org/blog/');
    expect(found).toEqual(['https://example.org/feed.xml', 'https://cdn.example.org/atom.xml']);
  });
  it('没有候选返回空', () => {
    expect(discoverFeedsInHtml('<html><head></head></html>', 'https://example.org/')).toEqual([]);
  });
});
