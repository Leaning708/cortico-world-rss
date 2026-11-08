import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RSS_DEFAULTS, type RssConfigSection } from '../src/config.ts';
import { RSS as RSS_DEFINITION } from '../src/definition.ts';
import { FetchFailure } from '../src/fetcher.ts';
import { RSS_TOOL_DECLS, RssWorld } from '../src/world.ts';

function response(body: string, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, { status, headers });
}

const RSS = (items: Array<[string, string]>, title = '测试源'): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${items
    .map(([uid, t]) => `<item><guid>${uid}</guid><title>${t}</title><link>https://x.org/${uid}</link><pubDate>Fri, 06 Nov 2026 08:00:00 GMT</pubDate></item>`)
    .join('')}</channel></rss>`;

const SITE_HTML = `<html><head><title>测试站点</title>
  <link rel="alternate" type="application/rss+xml" href="https://cdn.example.org/feed.xml"></head>
  <body>站点内容</body></html>`;

/** 工具回执可能是 string 或 ToolOutcome;统一取正文文本。 */
function receiptText(receipt: unknown): string {
  if (typeof receipt === 'string') return receipt;
  return String((receipt as { text?: string }).text ?? '');
}

function makeWorld(overrides: Partial<RssConfigSection> = {}, fetchScript?: (url: string) => Response) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-world-'));
  const cfg: RssConfigSection = { ...RSS_DEFAULTS, ...overrides };
  const world = new RssWorld({
    cfg,
    timezone: 'UTC',
    dataDir: dir,
    fetchImpl: fetchScript
      ? async (input) => Promise.resolve(fetchScript(String(input)))
      : async () => { throw new Error('no network in test'); },
    resolve: async (host) => (host === '127.0.0.1' ? ['127.0.0.1'] : ['93.184.216.34']),
  });
  const tools = Object.fromEntries(world.tools().map((tool) => [
    tool.name,
    async (args: Record<string, unknown> = {}) => tool.handler(args, { log: console } as never),
  ]));
  return { world, tools, cfg, dir };
}

/** 挂到 FakeHost 并等一拍,便于断言事件。 */
async function mounted(world: RssWorld) {
  const { FakeHost } = await import('./helpers/fake-host.ts');
  const host = new FakeHost();
  await world.start(host);
  return host;
}

describe('describe.json 一致性', () => {
  it('describe.json 存在且与代码声明逐字一致', () => {
    const path = join(process.cwd(), 'describe.json');
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(onDisk.tools).toEqual(RSS_DEFINITION.describe?.tools);
    expect(onDisk.events).toEqual(RSS_DEFINITION.describe?.events);
    const prompts = onDisk.prompts as Array<Record<string, unknown>>;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].content).toBe(readFileSync(new URL('../src/ENV_PROMPT.md', import.meta.url), 'utf8'));
  });

  it('工具名以 rss_ 开头且在声明里', () => {
    const names = RSS_DEFINITION.describe?.tools.map((tool: { name: string }) => tool.name) ?? [];
    expect(names).toHaveLength(RSS_TOOL_DECLS.length);
    for (const name of names) expect(name.startsWith('rss_')).toBe(true);
  });
});

describe('构造与配置', () => {
  it('默认配置 + 无网络可构造,enabled 默认 false', () => {
    expect(RSS_DEFAULTS.enabled).toBe(false);
    expect(() => makeWorld()).not.toThrow();
  });

  it('envPromptVars 渲染当前配置', () => {
    const { world } = makeWorld({ quietHours: '23:00-08:00', digestEnabled: true, digestTime: '08:30' });
    expect(world.envPromptVars()).toEqual({
      'rss.feedCount': '0',
      'rss.quietHours': '23:00-08:00',
      'rss.digestTime': '08:30',
    });
  });

  it('webUi:两个状态灯 + 五个标签面板(配置不进内建配置页)+ envPrompt 文档', () => {
    const { world } = makeWorld();
    const ui = world.webUi?.('zh');
    expect(ui?.lamps).toHaveLength(2);
    expect(ui?.lamps?.[0]?.state).toBe('offline');
    // 面板即标签:订阅源 / 收件箱 / 通知 / 设置 / OPML。
    expect(ui?.panels?.map((panel) => panel.id)).toEqual(['feeds', 'inbox', 'notify', 'settings', 'opml']);
    // 不声明 config groups → 内建「配置」标签不渲染;配置在自定义表单里走 config.save。
    expect(ui?.config).toBeUndefined();
    expect(ui?.promptDocs?.[0].role).toBe('envPrompt');
    expect(ui?.promptDocs?.[0].title).toBe('环境提示词');
  });

  it('config.get 返回全部旋钮当前值;config.save 白名单校验 + 写回 + persist', async () => {
    const persisted: unknown[] = [];
    const { world, cfg } = makeWorld();
    // 注入 persist 通道。
    (world as unknown as { persistCfg?: (patch: unknown) => void }).persistCfg = (patch) => persisted.push(patch);
    const ui = world.webUi?.('zh');
    const values = await ui?.invoke?.('manage', 'config.get', []) as Record<string, unknown>;
    expect(values.pollIntervalMinutes).toBe(30);
    expect(values.notifyDefault).toBe('notify');
    expect(Object.keys(values)).toHaveLength(19);
    // 合法保存:夹取 + 活配置生效 + persist 收到补丁。
    const saved = await ui?.invoke?.('manage', 'config.save', [{
      pollIntervalMinutes: 0, // 低于下限 → 钳到 1
      quietHours: '23:00-08:00',
      notifyDefault: 'digest',
      autoMarkReadOnNotify: true,
      watchKeywords: ' AI , 模型 ',
    }]) as { ok: boolean; restartRequired: boolean; applied: string[] };
    expect(saved.ok).toBe(true);
    expect(saved.restartRequired).toBe(false);
    expect(cfg.pollIntervalMinutes).toBe(1);
    expect(cfg.quietHours).toBe('23:00-08:00');
    expect(cfg.notifyDefault).toBe('digest');
    expect(cfg.autoMarkReadOnNotify).toBe(true);
    expect(cfg.watchKeywords).toBe('AI , 模型');
    expect(persisted).toHaveLength(1);
    expect(saved.applied).toHaveLength(5);
    // retentionDays 改动 → restartRequired。
    const saved2 = await ui?.invoke?.('manage', 'config.save', [{ retentionDays: 7 }]) as { restartRequired: boolean };
    expect(saved2.restartRequired).toBe(true);
    // 白名单外/格式错 → 整单拒绝。
    await expect(ui?.invoke?.('manage', 'config.save', [{ enabled: true }])).rejects.toThrow('未知或不可保存');
    await expect(ui?.invoke?.('manage', 'config.save', [{ quietHours: '25:00-99:99' }])).rejects.toThrow('HH:MM');
    await expect(ui?.invoke?.('manage', 'config.save', [{ notifyDefault: 'bomb' }])).rejects.toThrow('notify');
    expect(persisted).toHaveLength(2); // 两次合法保存落盘;被拒绝的三次不落盘
  });
});

describe('rss_add:发现、试解析、baseline', () => {
  it('直接 feed 地址:入库成功,历史静默(baseline 默认 0)', async () => {
    const { world, tools } = makeWorld({}, (url) => {
      if (String(url).includes('feed.xml')) return response(RSS([['a1', '第一条'], ['a2', '第二条']], '直连源'));
      return response('404', {}, 404);
    });
    const receipt = await tools.rss_add({ url: 'https://example.org/feed.xml' });
    expect(receipt).toContain('已订阅「直连源」');
    expect(receipt).toContain('历史条目已标记为已见');
    expect(receipt).toContain('第一条');
  });

  it('站点 URL 自动发现 feed', async () => {
    const { world, tools } = makeWorld({}, (url) => {
      if (String(url).endsWith('/site')) return response(SITE_HTML, { 'content-type': 'text/html' });
      return response(RSS([['s1', '站点源条目']], '发现的源'));
    });
    const receipt = await tools.rss_add({ url: 'https://example.org/site' });
    expect(receipt).toContain('自动发现');
    expect(receipt).toContain('发现的源');
    expect(world.envPromptVars()['rss.feedCount']).toBe('1');
  });

  it('解析失败拒绝入库并给诊断', async () => {
    const { tools } = makeWorld({}, () => response('这是一个普通页面,没有 feed 链接', { 'content-type': 'text/html' }));
    const receipt = receiptText(await tools.rss_add({ url: 'https://example.org/plain' }));
    expect(receipt).toMatch(/订阅失败/);
    expect(receipt).toMatch(/没有发现|解析|RSS/);
  });

  it('重复添加同一源变成更新,不新建', async () => {
    const { tools } = makeWorld({}, () => response(RSS([['a1', '第一条']], '直连源')));
    await tools.rss_add({ url: 'https://example.org/feed.xml' });
    const again = await tools.rss_add({ url: 'https://example.org/feed.xml', title: '新名字' });
    expect(again).toContain('已更新「新名字」');
  });

  it('baseline:1 时最新一条可推送,历史静默且已读', async () => {
    const { world, tools } = makeWorld({ baselineNotifyCount: 1 }, () => response(RSS([['old', '旧条目'], ['new', '最新条目']])));
    await tools.rss_add({ url: 'https://example.org/feed.xml' });
    const store = (world as unknown as { store: { itemsQuery(q: object): { items: Array<{ uid: string; notified: boolean; read: boolean }> }; unreadCount(): number } }).store;
    const items = store.itemsQuery({ scope: 'all' }).items;
    const newest = items.find((item) => item.uid === 'new');
    const oldest = items.find((item) => item.uid === 'old');
    expect(newest?.notified).toBe(false);
    expect(oldest?.notified).toBe(true);
    // 基线历史已读:不污染未读数(只有 newest 一条未读)。
    expect(newest?.read).toBe(false);
    expect(oldest?.read).toBe(true);
    expect(store.unreadCount()).toBe(1);
  });

  it('私网地址默认拒绝;按源放行可订阅', async () => {
    const denied = makeWorld();
    const receiptDenied = receiptText(await denied.tools.rss_add({ url: 'http://127.0.0.1:8787/rss.xml' }));
    expect(receiptDenied).toContain('私网');

    // 按源放行:全局开关不动,单源参数放行。
    const perFeed = makeWorld({}, () => response(RSS([['l2', '按源放行条目']], '按源源')));
    const receiptPerFeed = receiptText(await perFeed.tools.rss_add({ url: 'http://127.0.0.1:8787/rss.xml', allowPrivate: true }));
    expect(receiptPerFeed).toContain('已订阅「按源源」');
    const store = (perFeed.world as unknown as { store: import('../src/store.ts').RssStore }).store;
    expect(store.feeds()[0]?.allowPrivate).toBe(true);
    // 该源后续轮询也走按源放行(fetcher 断言走 resolve 注入:127.0.0.1 通过)。
    const outcomes = await perFeed.tools.rss_refresh({}) as string;
    expect(outcomes).toContain('新 0 条'); // guid 未变 → 0 新(200 全量但内容一致)
  });

  it('按源全文开关:feed.fullText=false 时 rss_read(full) 拒抓并提示', async () => {
    const env = makeWorld({}, () => response(RSS([['f1', '全文条目']], '关全文源')));
    const host = await mounted(env.world);
    await env.tools.rss_add({ url: 'https://example.org/feed.xml', fullText: false });
    const store = (env.world as unknown as { store: import('../src/store.ts').RssStore }).store;
    expect(store.feeds()[0]?.fullText).toBe(false);
    const key = `${store.feeds()[0].id}:f1`;
    const full = await env.tools.rss_read({ id: key, full: true });
    expect(full).toContain('关闭了全文抓取');
    await env.world.stop();
    void host;
  });

  it('容量上限拒绝', async () => {
    const { tools } = makeWorld({ maxFeeds: 1 }, () => response(RSS([['x', '条目']], '源')));
    await tools.rss_add({ url: 'https://one.org/feed.xml' });
    const second = receiptText(await tools.rss_add({ url: 'https://two.org/feed.xml' }));
    expect(second).toContain('容量上限');
  });
});

describe('事件链路', () => {
  it('refresh 的新条目经合批推送 debounce 事件,notified 标记;autoMarkReadOnNotify 生效', async () => {
    let body = RSS([['n1', '新条目一'], ['n2', '新条目二']]);
    const { world, tools } = makeWorld({ autoMarkReadOnNotify: true, eventBatchSeconds: 5 }, () => response(body));
    const host = await mounted(world);
    await tools.rss_add({ url: 'https://example.org/feed.xml' });
    expect(host.events).toHaveLength(0); // baseline 0:静默
    // 源发布了新内容(guid 变化)。
    body = RSS([['n1', '新条目一'], ['n2', '新条目二'], ['n3', '新条目三']]);
    await tools.rss_refresh({});
    // eventMaxHeadlines 默认 8,缓冲未到阈值,要等合批窗口 —— 手动 flush。
    (world as unknown as { poller: { flushBatch(): void } }).poller.flushBatch();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.events).toHaveLength(1);
    expect(host.events[0]?.type).toBe('rss.new_items');
    expect(host.events[0]?.origin).toBe('external');
    expect(host.pushOpts[0]?.trigger).toBe('debounce');
    expect(host.events[0]?.text).toContain('新条目三');
    // 送达后:autoMarkReadOnNotify → 新条目已读;基线历史也是已读(0.1.12 基线语义)。
    const store = (world as unknown as { store: import('../src/store.ts').RssStore }).store;
    const n3 = store.itemsQuery({ scope: 'all' }).items.find((item) => item.uid === 'n3');
    expect(n3?.read).toBe(true);
    expect(n3?.notified).toBe(true);
    const n1 = store.itemsQuery({ scope: 'all' }).items.find((item) => item.uid === 'n1');
    expect(n1?.read).toBe(true);
    await world.stop();
  });

  it('免打扰时段:事件改 piggyback 并在时段结束 promote(flush)', async () => {
    let body = RSS([['q1', '安静条目一']]);
    const { world, tools } = makeWorld({ quietHours: '00:00-23:59', eventBatchSeconds: 5 }, () => response(body));
    const host = await mounted(world);
    await tools.rss_add({ url: 'https://example.org/feed.xml' });
    body = RSS([['q1', '安静条目一'], ['q2', '安静条目二']]);
    await tools.rss_refresh({});
    (world as unknown as { poller: { flushBatch(): void } }).poller.flushBatch();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.pushOpts[0]?.trigger).toBe('piggyback');
    expect(host.events[0]?.meta?.quiet).toBe(true);
    const cursors = (world as unknown as { heldCursors: number[] }).heldCursors;
    expect(cursors).toHaveLength(1);
    // 手动触发释放(时段结束的等价动作)。
    (world as unknown as { releaseHeld(): void }).releaseHeld();
    expect(host.promoted).toEqual([{ cursor: cursors[0], trigger: 'flush' }]);
    await world.stop();
  });

  it('晨报:digestEnabled 时 onDigestDue → pushDeferred,render 汇总未读', async () => {
    const { world, tools } = makeWorld({ digestEnabled: true }, () => response(RSS([['d1', '晨报条目']])));
    const host = await mounted(world);
    // baseline:1 → 唯一条目保持未读,晨报才有"未读重点"可汇总。
    await tools.rss_add({ url: 'https://example.org/feed.xml', baseline: 1 });
    (world as unknown as { deliverDigest(): void }).deliverDigest();
    expect(host.deferred).toHaveLength(1);
    expect(host.deferred[0].spec.type).toBe('rss.daily_digest');
    const rendered = host.renderDeferred()[0];
    expect(rendered).toContain('RSS 晨报');
    expect(rendered).toContain('晨报条目');
    await world.stop();
  });

  it('feed_error 节流:同源 6 小时只推一次', async () => {
    let calls = 0;
    const failing = (): Response => { calls += 1; throw new FetchFailure('http', 'HTTP 404:e.org', { status: 404 }); };
    const { world, tools } = makeWorld({}, failing as never);
    const host = await mounted(world);
    await tools.rss_add({ url: 'https://example.org/feed.xml' });
    const poller = (world as unknown as { poller: { refresh(ids?: string[]): Promise<unknown> } }).poller;
    await poller.refresh();
    await poller.refresh();
    await poller.refresh();
    expect(host.events.filter((e) => e.type === 'rss.feed_error')).toHaveLength(0); // refresh 静默
    // 直接触发两次 deliverFeedError 验证节流。
    (world as unknown as { deliverFeedError(info: object): void }).deliverFeedError({
      feedId: 'f_x', feedTitle: 'X', code: 'http 404', consecutiveErrors: 3, hint: 'h',
    });
    (world as unknown as { deliverFeedError(info: object): void }).deliverFeedError({
      feedId: 'f_x', feedTitle: 'X', code: 'http 404', consecutiveErrors: 4, hint: 'h',
    });
    expect(host.events.filter((e) => e.type === 'rss.feed_error')).toHaveLength(1);
    void calls;
    await world.stop();
  });
});

describe('阅读与管理工具', () => {
  async function subscribed(overrides: Partial<RssConfigSection> = {}, fetchScript?: (url: string) => Response) {
    const env = makeWorld(overrides, fetchScript ?? (() => response(RSS([['r1', '可读条目'], ['r2', '第二条']], '阅读源'))));
    const host = await mounted(env.world);
    // baseline:2 → 两条都保持未读,后续 mark/unread 断言才有操作对象。
    await env.tools.rss_add({ url: 'https://example.org/feed.xml', baseline: 2 });
    const store = (env.world as unknown as { store: import('../src/store.ts').RssStore }).store;
    const key = `${store.feeds()[0].id}:r1`;
    return { ...env, host, store, key };
  }

  it('rss_unread + rss_read:摘要与全文抓取回落', async () => {
    // 文章页(x.org/r1)返回 500,验证 full:true 失败回落摘要。
    const env = await subscribed({}, (url) =>
      String(url).includes('x.org/r1') ? response('server error', {}, 500) : response(RSS([['r1', '可读条目'], ['r2', '第二条']], '阅读源')));
    const list = await env.tools.rss_unread({});
    expect(list).toContain('可读条目');
    expect(list).toMatch(/id: f_[0-9a-f]+:r1/);
    const read = await env.tools.rss_read({ id: env.key });
    expect(read).toContain('阅读源');
    expect(read).toContain('摘要');
    // full:true 但站点抓取失败 → 回落摘要并说明。
    const full = await env.tools.rss_read({ id: env.key, full: true });
    expect(full).toContain('抓取原文失败');
    expect(full).toContain('回落');
    await env.world.stop();
  });

  it('rss_mark:已读/星标/未读往返', async () => {
    const env = await subscribed();
    expect(await env.tools.rss_mark({ ids: [env.key], status: 'read' })).toContain('1 条');
    expect(env.store.unreadCount()).toBe(1);
    expect(await env.tools.rss_mark({ ids: [env.key], status: 'starred' })).toContain('1 条');
    const starred = await env.tools.rss_unread({ scope: 'starred' });
    expect(starred).toContain('★');
    expect(await env.tools.rss_mark({ ids: [env.key], status: 'unread' })).toContain('1 条');
    expect(await env.tools.rss_mark({ ids: [], status: 'read' })).toContain('ids 是空的');
    await env.world.stop();
  });

  it('rss_remove:退订即删除,历史条目一并移除', async () => {
    const env = await subscribed();
    const feedId = env.store.feeds()[0].id;
    expect(await env.tools.rss_remove({ feedId })).toContain('2 条历史条目已一并删除');
    expect(env.store.itemsQuery({ scope: 'all' }).total).toBe(0);
    expect(env.store.feeds()).toHaveLength(0);
    await env.world.stop();
  });

  it('rss_list 列出策略与状态', async () => {
    const env = await subscribed();
    const list = await env.tools.rss_list();
    expect(list).toContain('阅读源');
    expect(list).toContain('实时');
    expect(list).toContain('正常');
    await env.world.stop();
  });
});

describe('面板数据面', () => {
  it('overview / feeds / items / opml 全链路', async () => {
    let body = RSS([['p1', '面板条目']], '面板源');
    const env = makeWorld({}, () => response(body));
    const store = (env.world as unknown as { store: import('../src/store.ts').RssStore }).store;
    const world = env.world;
    const result = await world.webUi?.('zh')?.invoke?.('manage', 'overview', []);
    expect(result).toMatchObject({ feeds: 0, unread: 0 });
    await env.tools.rss_add({ url: 'https://example.org/feed.xml' });
    const feeds = await world.webUi?.('zh')?.invoke?.('manage', 'feeds.list', []);
    expect(Array.isArray(feeds)).toBe(true);
    const items = await world.webUi?.('zh')?.invoke?.('manage', 'items.list', [{ scope: 'unread' }]);
    // 0.1.12 基线语义:历史已读 → 未读为 0;切到"全部"能看到那条历史。
    expect((items as { total: number }).total).toBe(0);
    // 分页数据面:limit/offset 生效,total 恒为全量(此时库里只有 1 条,offset 越界 → 空页)。
    const paged = await world.webUi?.('zh')?.invoke?.('manage', 'items.list', [{ scope: 'all', limit: 1, offset: 1 }]) as { total: number; items: unknown[] };
    expect(paged.total).toBe(1);
    expect(paged.items).toHaveLength(0);
    // 手动拉取:内容更新后,面板触发真实轮询并报告新条数。
    body = RSS([['p1', '面板条目'], ['p2', '面板新条目']], '面板源');
    const pulled = await world.webUi?.('zh')?.invoke?.('manage', 'feeds.refresh', [{}]) as { ok: boolean; results: Array<{ ok: boolean; newCount: number }> };
    expect(pulled.ok).toBe(true);
    expect(pulled.results).toHaveLength(1);
    expect(pulled.results[0]?.newCount).toBe(1);
    // 单源拉取:内容无变化时报告 0 新条目(304 路径由 live 测试用真 ETag 覆盖)。
    const pulledAgain = await world.webUi?.('zh')?.invoke?.('manage', 'feeds.refresh', [{ id: store.feeds()[0].id }]) as { results: Array<{ ok: boolean; newCount: number }> };
    expect(pulledAgain.results[0]?.ok).toBe(true);
    expect(pulledAgain.results[0]?.newCount).toBe(0);
    // 手动拉取结束立即合批;该测试未挂宿主,批次被丢弃但缓冲已清空。
    expect((world as unknown as { poller: { pendingBatchSize(): number } }).poller.pendingBatchSize()).toBe(0);
    const opml = await world.webUi?.('zh')?.invoke?.('manage', 'opml.export', []);
    expect((opml as { opml: string }).opml).toContain('opml');
    const imported = await world.webUi?.('zh')?.invoke?.('manage', 'opml.import', [{
      opml: exportFixture((opml as { opml: string }).opml),
    }]);
    // 导入同一个 URL → addFeed 更新而非新建,ok 计 1。
    expect((imported as { ok: number }).ok).toBe(1);
    expect(store.feeds()).toHaveLength(1);
    await world.stop();
  });

  it('未知面板/方法报错', async () => {
    const { world } = makeWorld();
    const ui = world.webUi?.('zh');
    // 面板只是标签,方法全页共享:未知方法(无论哪个标签)报 unknown method。
    await expect(ui?.invoke?.('other', 'x', [])).rejects.toThrow('unknown method');
    await expect(ui?.invoke?.('manage', 'nope', [])).rejects.toThrow('unknown method');
  });
});

function exportFixture(original: string): string {
  return original.replace('面板源', '面板源');
}
