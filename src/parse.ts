/**
 * RSS 2.0 / Atom / RDF(RSS 1.0) 三种格式的归一化解析。
 * fast-xml-parser 只负责把 XML 变成对象;字段级兼容、HTML 剥离、实体解码、去重键都在这里。
 */
import { XMLParser } from 'fast-xml-parser';

export interface ParsedItem {
  /** 去重键:guid/atom:id > link > hash(title+description)。 */
  uid: string;
  title: string;
  /** 纯文本摘要(去标签、解实体)。 */
  description: string;
  /** content:encoded / atom:content 的原文(可能仍是 HTML),给 rss_read 用。 */
  contentHtml: string | null;
  url: string;
  author: string | null;
  /** ISO 8601;解析不出为 null,由调用方用抓取时间兜底。 */
  publishedAt: string | null;
  enclosure: { mime: string; url: string } | null;
}

export interface ParsedFeed {
  title: string;
  link: string | null;
  description: string | null;
  items: ParsedItem[];
}

/** XML 明显不是 feed 时抛出;消息给面板与回执直接显示。 */
export class ParseError extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  commentPropName: '#comment',
  cdataPropName: '#cdata',
});

type XmlNode = string | Record<string, unknown>;

function asArray(value: unknown): XmlNode[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value as XmlNode[];
  return [value as XmlNode];
}

/** 节点可能是 string、{'#text': string}(cdata/实体)或 {'@_attr': …, '#text': …} 的混合;取出文本部分。 */
function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join(' ');
  const record = node as Record<string, unknown>;
  const direct = record['#text'] ?? record['#cdata'];
  if (typeof direct === 'string') return direct;
  if (direct != null && typeof direct === 'object') return textOf(direct);
  // xhtml content 会展开成子元素;把所有字符串值拼起来,跳过属性。
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('@_') || key === '#comment') continue;
    const piece = textOf(value);
    if (piece) parts.push(piece);
  }
  return parts.join(' ');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  copy: '©', reg: '®', trade: '™', middot: '·', deg: '°', plusmn: '±',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** HTML → 纯文本:script/style 整块删除,块级标签换成换行,其余标签剥掉,实体解码,空白折叠。 */
export function stripHtml(html: string): string {
  const withoutBlocks = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|noscript)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const stripped = withoutBlocks.replace(/<[^>]*>/g, ' ');
  return decodeEntities(stripped)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** FNV-1a 32 位;去重键的第三级兜底,只需稳定,不需密码学强度。 */
export function hashUid(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function parseFeedDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** atom:link 可能是多个;优先 rel=alternate,其次没有 rel 的,最后第一个。 */
function pickLink(links: unknown[]): string {
  const records = links.map((link) => (typeof link === 'object' && link !== null ? link as Record<string, unknown> : {}));
  const href = (record: Record<string, unknown>): string => String(record['@_href'] ?? '');
  const alternate = records.find((r) => r['@_rel'] === 'alternate' && href(r));
  if (alternate) return href(alternate);
  const plain = records.find((r) => !r['@_rel'] && href(r));
  if (plain) return href(plain);
  return href(records[0] ?? {});
}

function enclosureOf(node: unknown): { mime: string; url: string } | null {
  const record = typeof node === 'object' && node !== null ? node as Record<string, unknown> : null;
  const url = record ? String(record['@_url'] ?? '') : '';
  if (!url) return null;
  const mime = record ? String(record['@_type'] ?? 'application/octet-stream') : 'application/octet-stream';
  return { mime, url };
}

function normalizeItem(raw: Record<string, unknown>, kind: 'rss' | 'atom'): ParsedItem | null {
  const title = stripHtml(textOf(raw.title)).slice(0, 500);
  const contentEncoded = raw['content:encoded'] ?? raw['content'];
  const contentHtml = contentEncoded != null ? textOf(contentEncoded) : null;
  const summaryRaw = raw.description ?? raw.summary ?? null;
  const description = summaryRaw != null ? stripHtml(textOf(summaryRaw)) : stripHtml(contentHtml ?? '');
  const url = kind === 'atom'
    ? pickLink(asArray(raw.link))
    : String(textOf(raw.link) ?? '').trim() || String(raw['@_rdf:about'] ?? '');
  const guidRaw = raw.guid ?? raw.id ?? null;
  const guid = guidRaw != null ? textOf(guidRaw).trim() : '';
  const author = raw.author != null
    ? stripHtml(textOf(typeof raw.author === 'object' && !Array.isArray(raw.author)
      ? (raw.author as Record<string, unknown>).name ?? raw.author
      : raw.author)).slice(0, 120) || null
    : null;
  const publishedAt = parseFeedDate(
    textOf(raw.pubDate ?? raw['dc:date'] ?? raw.published ?? raw.issued ?? raw.updated) || null,
  );
  const enclosure = enclosureOf(raw.enclosure ?? raw['media:content']);
  if (!title && !description && !url) return null;
  const uid = guid || url || hashUid(`${title}\u0000${description}`);
  return {
    uid,
    title,
    description,
    contentHtml: contentHtml && contentHtml.trim() ? contentHtml : null,
    url,
    author,
    publishedAt,
    enclosure,
  };
}

/** 解析 RSS 2.0 / Atom / RDF 三种格式;其余根元素一律 ParseError。 */
export function parseFeed(xml: string): ParsedFeed {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    throw new ParseError(`XML 解析失败:${error instanceof Error ? error.message : String(error)}`);
  }
  if (!doc || typeof doc !== 'object' || Object.keys(doc).length === 0) {
    throw new ParseError('响应不是 XML');
  }

  const rootKey = Object.keys(doc).find((key) => {
    const local = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    return local === 'rss' || local === 'feed' || local === 'RDF';
  });
  if (!rootKey) throw new ParseError('不是 RSS/Atom/RDF 格式(没有 rss/feed/RDF 根元素)');
  const root = doc[rootKey] as Record<string, unknown>;
  if (!root || typeof root !== 'object') throw new ParseError('feed 根元素为空');

  const localName = rootKey.includes(':') ? rootKey.slice(rootKey.indexOf(':') + 1) : rootKey;
  const kind = localName === 'feed' ? 'atom' : 'rss';
  const channelNode = kind === 'rss'
    ? asArray(root.channel)[0] ?? {}
    : root;
  const channel = (typeof channelNode === 'object' && channelNode !== null ? channelNode : {}) as Record<string, unknown>;

  const rawItems = kind === 'atom' ? asArray(root.entry) : asArray(channel.item).concat(kind === 'rss' ? asArray(root.item) : []);
  const items: ParsedItem[] = [];
  for (const raw of rawItems) {
    if (typeof raw !== 'object' || raw === null) continue;
    const normalized = normalizeItem(raw as Record<string, unknown>, kind === 'atom' ? 'atom' : 'rss');
    if (normalized) items.push(normalized);
  }

  const title = stripHtml(textOf(channel.title));
  const feedLink = kind === 'atom'
    ? pickLink(asArray(channel.link)) || null
    : String(textOf(channel.link)).trim() || null;
  const feedDescription = channel.description != null
    ? stripHtml(textOf(channel.description))
    : channel.subtitle != null ? stripHtml(textOf(channel.subtitle)) : null;

  if (!title && items.length === 0) throw new ParseError('feed 里既没有标题也没有条目');
  return { title, link: feedLink, description: feedDescription, items };
}

/** 站点页自动发现:读 <link rel="alternate" type="application/rss+xml|atom+xml">。 */
export function discoverFeedsInHtml(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const tagPattern = /<link\b[^>]*>/gi;
  for (const tag of html.match(tagPattern) ?? []) {
    const rel = /rel\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const type = /type\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '';
    if (!href) continue;
    if (!rel.split(/\s+/).includes('alternate')) continue;
    if (!/(application\/(rss|atom)\+xml|application\/feed\+xml)/.test(type)) continue;
    try {
      const resolved = new URL(href, baseUrl).toString();
      if (!out.includes(resolved)) out.push(resolved);
    } catch {
      // 相对地址解不出来就跳过。
    }
  }
  return out.slice(0, 5);
}
