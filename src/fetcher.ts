/**
 * HTTP 文本抓取:条件请求、重定向逐跳校验、体积上限、编码探测。
 * 测试通过 fetchImpl 注入,不碰真实网络。
 */
export type FetchImpl = typeof fetch;

export type FetchFailureKind =
  | 'scheme' | 'network' | 'timeout' | 'http' | 'size' | 'redirect' | 'parse';

export class FetchFailure extends Error {
  readonly kind: FetchFailureKind;
  readonly status?: number;
  /** 429/503 的 Retry-After(毫秒);没有为 null。 */
  readonly retryAfterMs: number | null;

  constructor(kind: FetchFailureKind, message: string, opts: { status?: number; retryAfterMs?: number | null } = {}) {
    super(message);
    this.name = 'FetchFailure';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

export interface FetchTextResult {
  status: number;
  body: string;
  etag: string | null;
  lastModified: string | null;
  finalUrl: string;
  contentType: string | null;
}

export interface FetchTextOptions {
  url: string;
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  etag?: string | null;
  lastModified?: string | null;
  maxRedirects?: number;
  fetchImpl?: FetchImpl;
}

/** scheme 校验;拒绝时抛 FetchFailure。 */
export function assertFetchableUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchFailure('scheme', `地址无法解析:${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchFailure('scheme', `只允许 http/https,收到 ${url.protocol}`);
  }
  return url;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 6 * 3600 * 1000);
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, Math.min(date.getTime() - Date.now(), 6 * 3600 * 1000));
  }
  return null;
}

/** 从 XML 前几百字节里嗅 encoding 声明(Content-Type 没写时兜底,常见于 GBK 老站)。 */
function sniffCharset(bytes: Uint8Array): string | null {
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 512));
  const match = /<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/i.exec(head);
  return match?.[1]?.toLowerCase() ?? null;
}

function charsetFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const match = /charset\s*=\s*"?([A-Za-z0-9._-]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? null;
}

function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const label = charsetFromContentType(contentType) ?? sniffCharset(bytes) ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** 抓文本。304 返回空 body;4xx/5xx、超时、超限都抛 FetchFailure。 */
export async function fetchText(options: FetchTextOptions): Promise<FetchTextResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? 3;
  let currentUrl = assertFetchableUrl(options.url);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs);
    const headers: Record<string, string> = {
      'user-agent': options.userAgent,
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5',
      'accept-charset': 'utf-8, gbk, gb2312, big5',
    };
    if (options.etag) headers['if-none-match'] = options.etag;
    if (options.lastModified) headers['if-modified-since'] = options.lastModified;

    let response: Response;
    try {
      response = await fetchImpl(currentUrl.toString(), {
        redirect: 'manual',
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('timeout') || controller.signal.aborted) {
        throw new FetchFailure('timeout', `请求超时(${options.timeoutMs}ms):${currentUrl.host}`);
      }
      throw new FetchFailure('network', `连接失败:${currentUrl.host}(${message})`);
    }

    // 重定向:逐跳重新过 scheme/私网校验。
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      clearTimeout(timer);
      const location = response.headers.get('location');
      if (!location) {
        throw new FetchFailure('http', `重定向缺少 Location(${response.status})`, { status: response.status });
      }
      if (hop >= maxRedirects) {
        throw new FetchFailure('redirect', `重定向次数超过 ${maxRedirects}:${currentUrl}`);
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        throw new FetchFailure('redirect', `重定向地址无效:${location}`);
      }
      currentUrl = assertFetchableUrl(next.toString());
      continue;
    }

    if (response.status === 304) {
      clearTimeout(timer);
      return {
        status: 304,
        body: '',
        etag: options.etag ?? null,
        lastModified: options.lastModified ?? null,
        finalUrl: currentUrl.toString(),
        contentType: null,
      };
    }

    if (!response.ok) {
      clearTimeout(timer);
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      throw new FetchFailure('http', `HTTP ${response.status}:${currentUrl.host}`, {
        status: response.status,
        retryAfterMs,
      });
    }

    // 体积上限:边读边累计,超限立刻放弃,不把 100MB 拉进内存。
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            total += value.byteLength;
            if (total > options.maxBytes) {
              clearTimeout(timer);
              void reader.cancel().catch(() => {});
              throw new FetchFailure('size', `响应超过 ${(options.maxBytes / 1024 / 1024).toFixed(1)} MB 上限:${currentUrl.host}`);
            }
            chunks.push(value);
          }
        }
      } finally {
        clearTimeout(timer);
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const contentType = response.headers.get('content-type');
    const body = decodeBody(merged, contentType);
    return {
      status: response.status,
      body,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      finalUrl: currentUrl.toString(),
      contentType,
    };
  }
  throw new FetchFailure('redirect', `重定向未收敛:${options.url}`);
}
