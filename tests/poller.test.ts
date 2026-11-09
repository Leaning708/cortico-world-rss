import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RSS_DEFAULTS, type RssConfigSection } from '../src/config.ts';
import { nextOccurrenceOfDayTime } from '../src/chrono.ts';
import { FetchFailure, type FetchTextOptions, type FetchTextResult } from '../src/fetcher.ts';
import { RssPoller, type BatchEvent, type FeedErrorInfo } from '../src/poller.ts';
import { RssStore } from '../src/store.ts';

function makeEnv(overrides: Partial<RssConfigSection> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-poller-'));
  const store = new RssStore(dir);
  const cfg: RssConfigSection = { ...RSS_DEFAULTS, ...overrides };
  const batches: BatchEvent[] = [];
  const feedErrors: FeedErrorInfo[] = [];
  let digestCalls = 0;
  const fetchHolder = {
    impl: async (_options?: FetchTextOptions): Promise<FetchTextResult> => { throw new Error('fetch not stubbed'); },
  };
  const poller = new RssPoller({
    cfg,
    store,
    timezone: 'UTC',
    fetchText: async (options: FetchTextOptions) => fetchHolder.impl(options),
    onBatch: (batch) => batches.push(batch),
    onFeedError: (info) => feedErrors.push(info),
    onDigestDue: () => { digestCalls += 1; },
  });
  return { poller, store, cfg, batches, feedErrors, digestCalls: () => digestCalls, fetchHolder };
}

function feedResponse(body: string, headers: Record<string, string> = {}): FetchTextResult {
  return { status: 200, body, etag: headers.etag ?? null, lastModified: headers['last-modified'] ?? null, finalUrl: 'https://x.org/feed', contentType: 'application/xml' };
}

const RSS = (items: Array<[string, string]>, title = '测试源'): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${items
    .map(([uid, t]) => `<item><guid>${uid}</guid><title>${t}</title><link>https://x.org/${uid}</link><pubDate>Fri, 06 Nov 2026 08:00:00 GMT</pubDate></item>`)
    .join('')}</channel></rss>`;

describe('RssPoller 合批与过滤', () => {
  it('notify 源的新条目进入缓冲,flushBatch 组事件:上限与 dropped', async () => {
    const env = makeEnv({ eventBatchSeconds: 5, eventMaxHeadlines: 2 });
    const feed = env.store.createFeed({ url: 'https://a.org/feed', title: 'A 源' });
    env.fetchHolder.impl = async () => feedResponse(RSS([['u1', '条目一'], ['u2', '条目二'], ['u3', '条目三']], 'A 源'));
    const outcomes = await env.poller.refresh([feed.id]);
    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[0]?.newCount).toBe(3);
    // 达到 maxHeadlines(2) 时立即 flush(此时第三条尚未入队,无 dropped);
    // refresh 结束再 flush 一次(手动拉取立即推送),第三条随之发出。
    expect(env.batches).toHaveLength(2);
    const batch = env.batches[0];
    expect(batch.text).toContain('RSS 2 条新内容');
    expect(batch.text).toContain('条目一');
    expect(batch.text).toContain('条目二');
    expect(batch.meta.itemKeys).toHaveLength(2);
    expect(env.poller.pendingBatchSize()).toBe(0);
    expect(env.batches[1]?.text).toContain('RSS 1 条新内容');
  });

  it('mute 源不进事件;notify 源全部推送', async () => {
    const mute = makeEnv();
    const m = mute.store.createFeed({ url: 'https://m.org/feed', title: 'M', notify: 'mute' });
    mute.fetchHolder.impl = async () => feedResponse(RSS([['m1', '静默条目']]));
    await mute.poller.refresh([m.id]);
    expect(mute.poller.pendingBatchSize()).toBe(0);

    // 普通 notify 源:不再有每源关键词过滤,全部进合批。
    const plain = makeEnv();
    const f = plain.store.createFeed({ url: 'https://f.org/feed', title: 'F' });
    plain.fetchHolder.impl = async () => feedResponse(RSS([['k1', '第一条'], ['k2', '第二条'], ['k3', '第三条']]));
    await plain.poller.refresh([f.id]);
    expect(plain.poller.pendingBatchSize()).toBe(0); // refresh 结束立即合批
    const text = plain.batches[0]?.text ?? '';
    expect(text).toContain('第一条');
    expect(text).toContain('第二条');
    expect(text).toContain('第三条');
  });

  it('失败退避:连续失败计数与退避时刻;成功后归零', async () => {
    const env = makeEnv();
    const feed = env.store.createFeed({ url: 'https://e.org/feed', title: 'E' });
    env.fetchHolder.impl = async () => { throw new FetchFailure('http', 'HTTP 404:e.org', { status: 404 }); };
    await env.poller.refresh([feed.id]);
    await env.poller.refresh([feed.id]);
    expect(env.store.feed(feed.id)?.consecutiveErrors).toBe(2);
    await env.poller.refresh([feed.id]);
    expect(env.store.feed(feed.id)?.consecutiveErrors).toBe(3);
    expect(env.store.feed(feed.id)?.lastError).toContain('404');
    // 退避后的 nextPollAt 在未来至少 5 分钟。
    const nextAt = new Date(env.store.feed(feed.id)?.nextPollAt ?? 0).getTime();
    expect(nextAt).toBeGreaterThan(Date.now() + 4 * 60_000);
    // 恢复后退避归零。
    env.fetchHolder.impl = async () => feedResponse(RSS([['ok1', '恢复']]));
    await env.poller.refresh([feed.id]);
    expect(env.store.feed(feed.id)?.consecutiveErrors).toBe(0);
    expect(env.store.feed(feed.id)?.nextPollAt).toBeTruthy();
  });

  it('304:不产生新条目,报告 notModified,etag 状态保留', async () => {
    const env = makeEnv();
    const feed = env.store.createFeed({ url: 'https://a.org/feed', title: 'A' });
    env.fetchHolder.impl = async () => ({ status: 304, body: '', etag: '"v1"', lastModified: null, finalUrl: 'https://x.org/feed', contentType: null });
    const outcomes = await env.poller.refresh([feed.id]);
    expect(outcomes[0]?.notModified).toBe(true);
    expect(outcomes[0]?.newCount).toBe(0);
    expect(env.poller.pendingBatchSize()).toBe(0);
    expect(env.store.feed(feed.id)?.consecutiveErrors).toBe(0);
  });

  it('duplicate 条目不重复进缓冲', async () => {
    const env = makeEnv();
    const feed = env.store.createFeed({ url: 'https://a.org/feed', title: 'A' });
    const body = RSS([['same', '同一条']]);
    env.fetchHolder.impl = async () => feedResponse(body);
    await env.poller.refresh([feed.id]);
    expect(env.batches).toHaveLength(1); // 手动拉取立即合批
    expect(env.poller.pendingBatchSize()).toBe(0);
    await env.poller.refresh([feed.id]);
    expect(env.poller.pendingBatchSize()).toBe(0); // 重复条目不再进缓冲
  });

  it('间隔下限 1 分钟:即使配置更小也钳到 ≥60s', async () => {
    const env = makeEnv({ pollIntervalMinutes: 0 }); // 非法值回落钳制
    const feed = env.store.createFeed({ url: 'https://a.org/feed', title: 'A', intervalMinutes: 1 });
    env.fetchHolder.impl = async () => feedResponse(RSS([['u1', '条目']]));
    const before = Date.now();
    await env.poller.refresh([feed.id]);
    const nextAt = new Date(env.store.feed(feed.id)?.nextPollAt ?? 0).getTime();
    const waitMs = nextAt - before;
    expect(waitMs).toBeGreaterThanOrEqual(59_000);
    expect(waitMs).toBeLessThanOrEqual(75_000);
  });

  it('adoptFeed baseline:历史静默,最新 N 条进缓冲', async () => {
    const env = makeEnv();
    const feed = env.store.createFeed({ url: 'https://a.org/feed', title: 'A' });
    env.fetchHolder.impl = async () => feedResponse(RSS([['old1', '旧一'], ['old2', '旧二'], ['new1', '最新']]));
    const adopted = await env.poller.adoptFeed(feed, 1, true);
    expect(adopted.status).toBe('ok');
    expect(adopted.freshCount).toBe(3);
    // 只有 baseline(最新 1 条)进了缓冲。
    expect(env.poller.pendingBatchSize()).toBe(1);
    env.poller.flushBatch();
    expect(env.batches[0]?.text).toContain('最新');
    expect(env.batches[0]?.text).not.toContain('旧一');
  });

  it('digest 回调:到达时刻 60s 内触发一次', () => {
    const target = nextOccurrenceOfDayTime(9 * 60, 'UTC', new Date('2026-11-06T00:00:00Z'));
    let now = new Date(target.getTime() - 120_000);
    let calls = 0;
    const poller = new RssPoller({
      cfg: { ...RSS_DEFAULTS, digestEnabled: true, digestTime: '09:00' },
      store: new RssStore(mkdtempSync(join(tmpdir(), 'rss-digest-'))),
      timezone: 'UTC',
      now: () => now,
      onDigestDue: () => { calls += 1; },
    });
    const tick = (): void => (poller as unknown as { maybeFireDigest(): void }).maybeFireDigest();
    tick();
    expect(calls).toBe(0); // 还差 2 分钟
    now = new Date(target.getTime() + 10_000);
    tick();
    expect(calls).toBe(1);
    now = new Date(target.getTime() + 20_000);
    tick();
    expect(calls).toBe(1); // 同一分钟不重复
    now = new Date(target.getTime() + 90_000);
    tick();
    expect(calls).toBe(1); // 已过窗口,下一次是明天
  });
});

describe('播报预览', () => {
  it('previewBatch 不消费缓冲,与随后 flush 文本一致', async () => {
    const env = makeEnv({ eventBatchSeconds: 5, eventMaxHeadlines: 10 });
    const feed = env.store.createFeed({ url: 'https://a.org/feed', title: 'A 源' });
    env.fetchHolder.impl = async () => feedResponse(RSS([['p1', '预览一'], ['p2', '预览二'], ['p3', '预览三']], 'A 源'));
    const poller = env.poller as unknown as {
      pollFeed(feed: unknown, opts?: unknown): Promise<unknown>;
    };
    await poller.pollFeed(env.store.feeds()[0], { silentError: true });
    expect(env.poller.pendingBatchSize()).toBe(3);
    expect(env.batches).toHaveLength(0);
    const preview = env.poller.previewBatch();
    expect(preview?.text).toContain('RSS 3 条新内容');
    expect(preview?.meta.total).toBe(3);
    expect(env.poller.pendingBatchSize()).toBe(3);
    expect(env.batches).toHaveLength(0);
    env.poller.flushBatch();
    expect(env.batches[0]?.text).toBe(preview?.text ?? '');
    expect(env.poller.pendingBatchSize()).toBe(0);
    void feed;
  });
});
