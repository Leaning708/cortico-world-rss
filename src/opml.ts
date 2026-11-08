/** OPML 2.0 导入导出;解析复用 fast-xml-parser,只认 xmlUrl 属性的 outline。 */
import { XMLParser } from 'fast-xml-parser';
import type { FeedRecord } from './store.ts';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
  trimValues: true,
});

export interface OpmlEntry {
  url: string;
  title: string;
}

/** 递归收集带 xmlUrl 的 outline;去重按 URL。 */
export function parseOpml(xml: string): OpmlEntry[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new Error('不是有效的 OPML/XML');
  }
  if (!doc || typeof doc !== 'object' || !doc.opml) {
    throw new Error('不是有效的 OPML(缺少 opml 根元素)');
  }
  const out: OpmlEntry[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const xmlUrl = record['@_xmlUrl'];
    if (typeof xmlUrl === 'string' && xmlUrl.trim()) {
      const url = xmlUrl.trim();
      if (!seen.has(url)) {
        seen.add(url);
        const title = typeof record['@_title'] === 'string' && record['@_title'].trim()
          ? record['@_title'].trim()
          : typeof record['@_text'] === 'string' ? record['@_text'].trim() : url;
        out.push({ url, title });
      }
    }
    walk(record.outline);
    walk(record.body);
  };
  walk(doc.opml);
  return out;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 导出当前订阅;title 优先,缺了用 URL。 */
export function exportOpml(feeds: readonly FeedRecord[]): string {
  const outlines = feeds
    .map((feed) => `    <outline type="rss" text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" xmlUrl="${escapeXml(feed.url)}"/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Coopanion RSS subscriptions</title>
    <dateCreated>${new Date().toISOString()}</dateCreated>
  </head>
  <body>
${outlines || '    <!-- empty -->'}
  </body>
</opml>
`;
}
