import { describe, expect, it } from 'vitest';
import { assertFetchableUrl, fetchText, FetchFailure } from '../src/fetcher.ts';

const base = {
  timeoutMs: 1_000,
  maxBytes: 1_000_000,
  userAgent: 'test-agent',
};

function jsonResponse(body: string, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, { status, headers });
}

describe('assertFetchableUrl', () => {
  it('只接受 http/https;私网/本机地址默认允许', () => {
    expect(() => assertFetchableUrl('ftp://x.com')).toThrow(FetchFailure);
    expect(() => assertFetchableUrl('file:///etc/passwd')).toThrow(FetchFailure);
    expect(() => assertFetchableUrl('不是地址')).toThrow(FetchFailure);
    expect(assertFetchableUrl('http://localhost:8080/f')).toBeInstanceOf(URL);
    expect(assertFetchableUrl('http://192.168.1.5/feed')).toBeInstanceOf(URL);
  });
});

describe('fetchText', () => {
  it('条件请求:带 If-None-Match/If-Modified-Since,304 短路', async () => {
    let seenHeaders: Record<string, string> = {};
    const result = await fetchText({
      ...base,
      url: 'https://example.org/feed.xml',
      etag: '"v1"',
      lastModified: 'Thu, 06 Nov 2026 00:00:00 GMT',
      fetchImpl: async (_url, init) => {
        seenHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}));
        return new Response(null, { status: 304 });
      },
    });
    expect(seenHeaders['if-none-match']).toBe('"v1"');
    expect(seenHeaders['if-modified-since']).toBe('Thu, 06 Nov 2026 00:00:00 GMT');
    expect(seenHeaders['user-agent']).toBe('test-agent');
    expect(result.status).toBe(304);
    expect(result.body).toBe('');
  });

  it('跟随重定向', async () => {
    const calls: string[] = [];
    const result = await fetchText({
      ...base,
      url: 'https://example.org/a',
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (String(url) === 'https://example.org/a') {
          return jsonResponse('', { location: 'https://cdn.example.org/b' }, 301);
        }
        return jsonResponse('最终内容');
      },
    });
    expect(calls).toHaveLength(2);
    expect(result.body).toBe('最终内容');
    expect(result.finalUrl).toBe('https://cdn.example.org/b');
    // 重定向超过 3 跳 → redirect 失败。
    await expect(fetchText({
      ...base,
      url: 'https://example.org/a',
      maxRedirects: 1,
      fetchImpl: async () => jsonResponse('', { location: 'https://example.org/next' }, 302),
    })).rejects.toThrow('重定向');
  });

  it('非 2xx 抛 http,Retry-After 被解析', async () => {
    const error = await fetchText({
      ...base,
      url: 'https://example.org/feed',
      fetchImpl: async () => jsonResponse('slow down', { 'retry-after': '120' }, 429),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(FetchFailure);
    expect(error.kind).toBe('http');
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(120_000);
  });

  it('响应体超过上限抛 size 且不再继续读', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(600_000));
        if (cancelled) controller.close();
      },
      cancel() { cancelled = true; },
    });
    const error = await fetchText({
      ...base,
      maxBytes: 1_000_000,
      url: 'https://example.org/big',
      fetchImpl: async () => new Response(stream, { status: 200 }),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(FetchFailure);
    expect(error.kind).toBe('size');
  });

  it('超时抛 timeout', async () => {
    const error = await fetchText({
      ...base,
      timeoutMs: 30,
      url: 'https://example.org/slow',
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timeout because aborted')));
      }),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(FetchFailure);
    expect(error.kind).toBe('timeout');
  });

  it('GBK 响应按 Content-Type 解码', async () => {
    // "中文" 的 GBK 字节:d6 d0 ce c4。
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    const result = await fetchText({
      ...base,
      url: 'https://example.org/gbk',
      fetchImpl: async () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/xml; charset=gbk' } }),
    });
    expect(result.body).toBe('中文');
  });

  it('Content-Type 没写时从 XML 声明嗅探', async () => {
    const xml = `<?xml version="1.0" encoding="gbk"?><rss><channel><title>中文</title></channel></rss>`;
    const bytes = new TextEncoder().encode(xml); // 实际是 UTF-8 字节,但声明说是 gbk → 会解错,验证嗅探生效即可
    const result = await fetchText({
      ...base,
      url: 'https://example.org/declared',
      fetchImpl: async () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/xml' } }),
    });
    // 声明 gbk 但内容是 utf-8,解码必然乱码 —— 断言走的是 gbk 解码器(非 utf-8 直读)。
    expect(result.body).not.toBe(xml);
  });

  it('网络错误抛 network', async () => {
    const error = await fetchText({
      ...base,
      url: 'https://example.org/x',
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(FetchFailure);
    expect(error.kind).toBe('network');
  });
});
