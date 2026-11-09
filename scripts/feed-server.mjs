#!/usr/bin/env node
/**
 * 本地 RSS 测试服务器(零依赖)——给 Coopanion 装上扩展后的真机验收用。
 *
 *   node scripts/feed-server.mjs            # 默认 127.0.0.1:8787
 *   RSS_TEST_PORT=8788 node scripts/feed-server.mjs
 *
 * 端点:
 *   GET  /               说明页
 *   GET  /rss.xml        RSS 2.0(UTF-8),动态条目,支持 ETag/304
 *   GET  /atom.xml       Atom(UTF-8)
 *   GET  /feed.json      JSON Feed 1.1
 *   GET  /gbk.xml        RSS 2.0(GBK 编码,静态)——验证编码探测
 *   GET  /broken.xml     非法 XML——验证错误处理
 *   GET  /site           HTML 站点页(带 <link rel=alternate> 指向 /rss.xml)——验证自动发现
 *   GET  /error/404|403  固定错误码
 *   GET  /headers        回显请求头(JSON)——验证 User-Agent
 *   POST /publish        {feed:"rss"|"atom", title, description?} 追加一条新条目
 *   POST /clear          {feed} 清空某源的动态条目
 *
 * 用途(在 Coopanion 的 World 页把 allowPrivateFeeds 打开后):
 *   1. 面板/对话添加 http://127.0.0.1:8787/rss.xml → 立即出现条目
 *   2. curl -X POST :8787/publish -d '{"feed":"rss","title":"新消息"}' → 20s 内 Coo 播报
 *   3. 再发一次同样内容 → 无重复推送
 *   4. 添加 http://127.0.0.1:8787/site → 自动发现 /rss.xml
 *   5. 添加 /gbk.xml → 中文正常显示
 *   6. 添加 /broken.xml → 试解析拒绝;已订阅则 feed_error
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.RSS_TEST_PORT || 8787);

/** GBK 静态样例(见文件头注释;由 PowerShell GBK 码页生成)。 */
const GBK_BASE64 =
  'PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iZ2JrIj8+PHJzcyB2ZXJzaW9uPSIyLjAiPjxjaGFubmVsPjx0aXRsZT5HQksgseDC67LiytTUtDwvdGl0bGU+PGl0ZW0+PHRpdGxlPrXa0rvM9TrW0M7EseDC67LiytQ8L3RpdGxlPjxkZXNjcmlwdGlvbj7V4srHIEdCSyCx4MLrtcTD6Mr2xNrI3SzR6dakveLC68G0wrehozwvZGVzY3JpcHRpb24+PC9pdGVtPjxpdGVtPjx0aXRsZT612rb+zPU6u+y6zyBFbmdsaXNoIMTayN08L3RpdGxlPjxkZXNjcmlwdGlvbj5NaXhlZCBjb250ZW50IHdvcmtzIHRvby48L2Rlc2NyaXB0aW9uPjwvaXRlbT48L2NoYW5uZWw+PC9yc3M+';

const nowIso = () => new Date().toUTCString();
const iso = (offsetMinutes = 0) => new Date(Date.now() - offsetMinutes * 60_000).toISOString();

const staticFeeds = {
  'feed.json': {
    items: [
      { title: 'JSON Feed 条目一', description: '这是 /feed.json 的第一条。', at: iso(10) },
    ],
  },
  'rss.xml': {
    items: [
      { title: '欢迎条目:本地测试服务器已就绪', description: '这是 /rss.xml 的第一条。POST /publish 可以追加新条目测试推送。', at: iso(30) },
      { title: 'Second item: HTML in description', description: '<p>Should be <b>stripped</b> to plain text &amp; entities decoded.</p>', at: iso(120) },
    ],
  },
  'atom.xml': {
    items: [
      { title: 'Atom entry one', description: 'Atom 格式的摘要文本。', at: iso(45) },
    ],
  },
};
const GUID_BASE = { 'rss.xml': 'https://test.local/post-', 'atom.xml': 'urn:test:entry-' };

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderJsonFeed() {
  const store = staticFeeds['feed.json'];
  return JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: '本地 JSON Feed 测试源',
    home_page_url: 'https://test.local/',
    feed_url: 'https://test.local/feed.json',
    description: 'Coopanion RSS 扩展的本机 JSON Feed 验收源',
    items: [...store.items].reverse().map((item, i) => ({
      id: `json-${store.items.length - i}`,
      url: `https://test.local/json/${store.items.length - i}`,
      title: item.title,
      content_text: item.description,
      date_published: item.at,
    })),
  }, null, 2);
}

function renderRss(name) {
  const store = staticFeeds[name];
  if (name === 'atom.xml') {
    const entries = [...store.items].reverse().map((item, i) => `
    <entry>
      <id>${GUID_BASE[name]}${store.items.length - i}</id>
      <title>${esc(item.title)}</title>
      <link rel="alternate" href="https://test.local/atom/${store.items.length - i}"/>
      <updated>${item.at}</updated>
      <summary>${esc(item.description)}</summary>
    </entry>`).join('');
    return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>本地 Atom 测试源</title>
  <link rel="alternate" href="https://test.local/"/>
  <updated>${iso(0)}</updated>
  <id>urn:test:atom-feed</id>${entries}
</feed>`;
  }
  const items = [...store.items].reverse().map((item, i) => `
    <item>
      <guid isPermaLink="false">${GUID_BASE[name]}${store.items.length - i}</guid>
      <title>${esc(item.title)}</title>
      <link>https://test.local/rss/${store.items.length - i}</link>
      <pubDate>${new Date(item.at).toUTCString()}</pubDate>
      <description>${esc(item.description)}</description>
    </item>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>本地 RSS 测试源</title>
    <link>https://test.local/</link>
    <description>Coopanion RSS 扩展的本机验收源</description>${items}
  </channel>
</rss>`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const respond = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
    res.end(body);
  };
  const respondXml = (body, etagSeed) => {
    const etag = `"${createHash('sha1').update(etagSeed ?? body).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8', etag });
    res.end(body);
  };

  if (path === '/publish' && (req.method === 'POST' || req.method === 'GET')) {
    // POST 收 JSON body;GET 收查询参数(浏览器地址栏就能发,仅本地测试工具)。
    if (req.method === 'GET') {
      const payload = {
        feed: url.searchParams.get('feed') ?? 'rss',
        title: url.searchParams.get('title') ?? '未命名',
        description: url.searchParams.get('description') ?? '',
      };
      const name = payload.feed === 'atom' ? 'atom.xml' : payload.feed === 'json' ? 'feed.json' : 'rss.xml';
      staticFeeds[name].items.push({
        title: payload.title,
        description: payload.description,
        at: new Date().toISOString(),
      });
      respond(200, `published to ${name}, total ${staticFeeds[name].items.length}`);
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(raw || '{}');
        const name = payload.feed === 'atom' ? 'atom.xml' : payload.feed === 'json' ? 'feed.json' : 'rss.xml';
        const store = staticFeeds[name];
        store.items.push({
          title: String(payload.title ?? '未命名'),
          description: String(payload.description ?? ''),
          at: new Date().toISOString(),
        });
        respond(200, `published to ${name}, total ${store.items.length}`);
      } catch (error) {
        respond(400, `bad json: ${error.message}`);
      }
    });
    return;
  }
  if (req.method === 'POST' && path === '/clear') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(raw || '{}');
        const name = payload.feed === 'atom' ? 'atom.xml' : payload.feed === 'json' ? 'feed.json' : 'rss.xml';
        staticFeeds[name].items = [];
        respond(200, `cleared ${name}`);
      } catch (error) {
        respond(400, `bad json: ${error.message}`);
      }
    });
    return;
  }

  switch (path) {
    case '/':
      respond(200, [
        '本地 RSS 测试服务器。可用端点:',
        '  GET /rss.xml    RSS 2.0 (UTF-8, ETag/304)',
        '  GET /atom.xml   Atom (UTF-8, ETag/304)',
        '  GET /feed.json  JSON Feed 1.1',
        '  GET /gbk.xml    RSS 2.0 (GBK 编码)',
        '  GET /site       HTML 站点页(自动发现 /rss.xml)',
        '  GET /broken.xml 非法 XML',
        '  GET /error/404  /error/403',
        '  GET /headers    回显请求头',
        '  POST /publish   {"feed":"rss"|"atom"|"json","title":"...","description":"..."}',
        '  POST /clear     {"feed":"rss"}',
      ].join('\n'));
      return;
    case '/rss.xml':
      respondXml(renderRss('rss.xml'), JSON.stringify(staticFeeds['rss.xml'].items.map((i) => i.title)));
      return;
    case '/atom.xml':
      respondXml(renderRss('atom.xml'), JSON.stringify(staticFeeds['atom.xml'].items.map((i) => i.title)));
      return;
    case '/feed.json':
      respond(200, renderJsonFeed(), { 'content-type': 'application/feed+json; charset=utf-8' });
      return;
    case '/gbk.xml': {
      const bytes = Buffer.from(GBK_BASE64, 'base64');
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(bytes);
      return;
    }
    case '/broken.xml':
      // 故意不是 feed:一个普通 HTML 页(自动发现也找不到链接)→ 试解析应拒绝。
      respond(200, '<!doctype html><html><head><title>坏源</title></head><body><p>这里没有 feed 链接。</p></body></html>',
        { 'content-type': 'text/html; charset=utf-8' });
      return;
    case '/site':
      respond(200, `<!doctype html>
<html><head>
<title>测试站点首页</title>
<link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml">
</head><body><h1>测试站点</h1><p>本页应能被自动发现 feed。</p></body></html>`, { 'content-type': 'text/html; charset=utf-8' });
      return;
    case '/error/404':
      respond(404, 'not found');
      return;
    case '/error/403':
      respond(403, 'forbidden');
      return;
    case '/headers':
      respond(200, JSON.stringify(req.headers, null, 2), { 'content-type': 'application/json' });
      return;
    default:
      respond(404, `no such path: ${path}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`RSS 测试服务器:http://127.0.0.1:${PORT}/  (Ctrl+C 停止)`);
});
