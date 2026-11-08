import { describe, expect, it } from 'vitest';
import { extractArticle } from '../src/extract.ts';

const PAGE = `<!doctype html>
<html>
<head><title>文章标题 - 站点名</title><style>body{color:red}</style></head>
<body>
<nav><a href="/">首页</a><a href="/about">关于</a></nav>
<article>
  <h1>本地优先软件的兴起</h1>
  <p>本地优先(local-first)是一种软件设计理念:数据以本机为家,网络只做同步。这段长度足以被保留下来,因为它超过了三十个字符的门槛。</p>
  <p>第二段:离线可用、隐私可控、没有供应商锁定,是它最常被列举的三个好处,同样是一段足够长的有效文本。</p>
  <script>console.log('should be removed')</script>
</article>
<aside>侧栏广告,应被剔除。</aside>
<footer>© 2026 测试站点</footer>
</body>
</html>`;

describe('extractArticle', () => {
  it('抽取 article 容器内的块级段落,去掉 script/nav/aside', () => {
    const { title, text } = extractArticle(PAGE);
    expect(title).toContain('文章标题');
    expect(text).toContain('本地优先');
    expect(text).toContain('第二段');
    expect(text).not.toContain('should be removed');
    expect(text).not.toContain('侧栏广告');
    expect(text).not.toContain('首页');
  });

  it('正文太短时回落整页去壳', () => {
    const html = '<html><body><p>短</p></body></html>';
    const { text } = extractArticle(html);
    expect(text).toContain('短');
  });

  it('maxChars 截断', () => {
    const long = `<html><body>${'<p>这是一段足够长的文本,用来测试截断逻辑,重复内容。'.repeat(100)}</p></body></html>`;
    const { text } = extractArticle(long, 300);
    expect(text.length).toBeLessThanOrEqual(310);
    expect(text).toContain('截断');
  });
});
