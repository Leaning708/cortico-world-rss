/**
 * 真机集成测试:自起 scripts/feed-server.mjs,经真实 HTTP(127.0.0.1)驱动完整链路。
 * 默认跳过;`RSS_LIVE_TEST=1 pnpm test` 或 `RSS_LIVE_TEST=1 npx vitest run tests/live.test.ts` 启用。
 * 不访问任何外部地址。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RSS_DEFAULTS, type RssConfigSection } from '../src/config.ts';
import { RssWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

const PORT = 8891 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const ENABLED = process.env.RSS_LIVE_TEST === '1';

describe.skipIf(!ENABLED)('live:本地 RSS 服务器全链路', () => {
  let server: ChildProcess;
  let world: RssWorld;
  let host: FakeHost;
  let tools: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  const cfg: RssConfigSection = { ...RSS_DEFAULTS, eventBatchSeconds: 5 };

  beforeAll(async () => {
    server = spawn(process.execPath, [join(process.cwd(), 'scripts', 'feed-server.mjs')], {
      env: { ...process.env, RSS_TEST_PORT: String(PORT) },
      stdio: 'pipe',
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('feed server 启动超时')), 5_000);
      server.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('RSS 测试服务器')) { clearTimeout(timer); resolve(); }
      });
      server.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    world = new RssWorld({
      cfg,
      timezone: 'UTC',
      dataDir: mkdtempSync(join(tmpdir(), 'rss-live-')),
    });
    host = new FakeHost();
    await world.start(host);
    tools = Object.fromEntries(world.tools().map((tool) => [tool.name, tool.handler as (args: Record<string, unknown>) => Promise<unknown>]));
  }, 15_000);

  afterAll(async () => {
    await world.stop();
    server.kill();
  });

  it('添加动态 RSS 源 → 历史静默', async () => {
    const receipt = await tools.rss_add({ url: `${BASE}/rss.xml` }) as string;
    expect(receipt).toContain('已订阅「本地 RSS 测试源」');
    expect(receipt).toContain('欢迎条目');
  });

  it('条件请求生效:第二次拉取 304', async () => {
    const receipt = (await tools.rss_refresh({})) as string;
    expect(receipt).toContain('无更新(304)');
  });

  it('发布新条目 → 刷新 → 合批事件到达', async () => {
    const response = await fetch(`${BASE}/publish`, {
      method: 'POST',
      body: JSON.stringify({ feed: 'rss', title: '直播新消息:发布测试', description: '由 live 测试注入' }),
    });
    expect(response.status).toBe(200);
    const receipt = (await tools.rss_refresh({})) as string;
    expect(receipt).toContain('新 1 条');
    (world as unknown as { poller: { flushBatch(): void } }).poller.flushBatch();
    expect(host.events.filter((e) => e.type === 'rss.new_items')).toHaveLength(1);
    const event = host.events.find((e) => e.type === 'rss.new_items');
    expect(event?.text).toContain('直播新消息:发布测试');
    expect(event?.origin).toBe('external');
  });

  it('再发布一条 → guid 变化即新条目', async () => {
    await fetch(`${BASE}/publish`, { method: 'POST', body: JSON.stringify({ feed: 'rss', title: '第二条直播' }) });
    const receipt = (await tools.rss_refresh({})) as string;
    expect(receipt).toContain('新 1 条');
  });

  it('GBK 源中文正常解析', async () => {
    const receipt = await tools.rss_add({ url: `${BASE}/gbk.xml` }) as string;
    expect(receipt).toContain('GBK 编码测试源');
    expect(receipt).toContain('中文编码测试');
  });

  it('站点页自动发现', async () => {
    const receipt = await tools.rss_add({ url: `${BASE}/site` }) as string;
    expect(receipt).toContain('自动发现');
  });

  it('坏源拒绝;错误码源给诊断', async () => {
    // /broken.xml 实际是无 feed 链接的 HTML 页面 → 自动发现失败 → 拒绝。
    const unwrap = (value: unknown): string => (typeof value === 'string' ? value : String((value as { text?: string }).text ?? ''));
    const broken = unwrap(await tools.rss_add({ url: `${BASE}/broken.xml` }));
    expect(broken).toContain('订阅失败');
    const notFound = unwrap(await tools.rss_add({ url: `${BASE}/error/404` }));
    expect(notFound).toContain('订阅失败');
    expect(notFound).toContain('404');
  });

  it('未读浏览与标记往返', async () => {
    const unread = await tools.rss_unread({}) as string;
    expect(unread).toContain('欢迎条目');
    const store = (world as unknown as { store: { itemsQuery(q: object): { items: Array<{ key: string }> } } }).store;
    const key = store.itemsQuery({ scope: 'unread', limit: 1 }).items[0]?.key;
    expect(await tools.rss_mark({ ids: [key], status: 'starred' })).toContain('1 条');
    expect(await tools.rss_unread({ scope: 'starred' }) as string).toContain('★');
  });

  it('OPML 导出包含已订阅源', async () => {
    const ui = world.webUi?.('zh');
    const result = await ui?.invoke?.('manage', 'opml.export', []) as { opml: string };
    expect(result.opml).toContain('本地 RSS 测试源');
    expect(result.opml).toContain('GBK 编码测试源');
  });
});
