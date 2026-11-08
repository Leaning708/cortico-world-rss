/**
 * 文章正文抽取:轻量启发式,不引 DOM 依赖。
 * 先定位主内容容器(article/main/role=main),收集块级文本;结果太短时回落整页去壳。
 */

const REMOVED_TAGS = 'script|style|noscript|svg|iframe|form|button|select|textarea|nav|header|footer|aside';

function removeNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(new RegExp(`<(${REMOVED_TAGS})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, 'gi'), ' ')
    .replace(new RegExp(`<(${REMOVED_TAGS})\\b[^>]*/?>`, 'gi'), ' ');
}

function findTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = match[1].replace(/<[^>]*>/g, ' ').trim();
  return title || null;
}

/** 找主内容容器:article > main/[role=main] > 整个文档。 */
function findContainer(html: string): string {
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  if (article && article[1].length > 500) return article[1];
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)
    ?? /<div\b[^>]*role\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (main && main[1].length > 500) return main[1];
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return body?.[1] ?? html;
}

const BLOCK_PATTERN = /<(p|h[1-6]|li|blockquote|figcaption|dd|dt)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;

/**
 * 抽出正文纯文本。
 * 块级文本段落按出现顺序拼接;每段至少 30 个字符(去噪后的有效文本);
 * 总长不足 80 字符时回落"整页去壳"。
 */
export function extractArticle(html: string, maxChars = 12_000): { title: string | null; text: string } {
  const title = findTitle(html);
  const container = removeNoise(findContainer(html));
  const paragraphs: string[] = [];
  for (const match of container.matchAll(BLOCK_PATTERN)) {
    const text = match[2]
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/[ \t\u00a0]+/g, ' ')
      .trim();
    // 解实体后长度才算数。
    const decoded = text;
    if (decoded.length < 30) continue;
    // 全是标点/符号的段落(分享按钮、版权条)丢弃。
    const letters = decoded.replace(/[^\p{L}\p{N}]/gu, '');
    if (letters.length < Math.min(10, decoded.length * 0.2)) continue;
    paragraphs.push(decoded);
  }
  let text = paragraphs.join('\n\n');
  if (text.length < 80) {
    text = container.replace(/<[^>]*>/g, ' ').replace(/[ \t\u00a0]+/g, ' ').trim();
  }
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…[截断]`;
  return { title, text };
}
