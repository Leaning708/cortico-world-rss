/**
 * RSS World:7 个工具(订阅管理 + 阅读) + 3 类事件(合批新内容/源故障/晨报) + WebUI 管理面板。
 * 扩展只负责"少而准地喂":去重、过滤、合批、截断；精简与转述由 Coo 主循环完成。
 */
import { fileURLToPath } from 'node:url';
import type {
  ToolDef,
  ToolOutcome,
  World,
  WorldHost,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { describeTools } from 'cortico/world.ts';
import {
  NOTIFY_MODES,
  RSS_ID,
  type RssConfigSection,
} from './config.ts';
import { RSS_CONFIG_KEYS, sanitizeConfigPatch } from './config-save.ts';
import { relativeTime } from './chrono.ts';
import { extractArticle } from './extract.ts';
import { fetchText, FetchFailure, type FetchImpl } from './fetcher.ts';
import { discoverFeedsInHtml, parseFeed, ParseError } from './parse.ts';
import { RssPoller, type BatchEvent, type FeedErrorInfo } from './poller.ts';
import { exportOpml, parseOpml } from './opml.ts';
import { DEFAULT_LIMITS, RssStore, type FeedRecord, type NotifyMode as StoreNotifyMode, type StoreLimits } from './store.ts';
import { text } from './strings.ts';
import { DEFAULT_USER_AGENT } from './version.ts';

export const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

// ── 体积预算 ────────────────────────────────────────────────────────────
const LIST_RECEIPT_CHARS = 4_000;
const UNREAD_RECEIPT_CHARS = 8_000;
const READ_RECEIPT_CHARS = 12_000;
/** 全文缓存有效期:过期后重新抓取,避免长期保存已变更的正文。 */
const FULLTEXT_TTL_MS = 7 * 24 * 3600 * 1000;
const ACTION_RECEIPT_CHARS = 4_000;
const ARTICLE_BYTES = 1024 * 1024;
const UNREAD_MAX_LIMIT = 50;
const MARK_MAX_KEYS = 50;

function clip(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}…[截断]`;
}

/** 全部工具的声明；定义里的 describe 与 `tools()` 都取它。描述面向模型，用英文。 */
export const RSS_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'rss_list',
    description:
      'List RSS feed subscriptions with health status: notify policy, interval, unread count, last success or last error. Use it when the user asks what they are subscribed to, or before removing a feed by id.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'rss_unread',
    description:
      'List recent items from the inbox. Default scope is unread; starred lists saved items. Each row shows the item id you pass to rss_read. Use it to browse what arrived or to pick items worth telling the user about.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        feedId: { type: 'string', description: 'Restrict to one feed id from rss_list, e.g. f_9k2x.' },
        scope: { type: 'string', enum: ['unread', 'all', 'starred'], description: 'Default unread.' },
        query: { type: 'string', description: 'Case-insensitive substring matched against title and summary.' },
        limit: { type: 'integer', minimum: 1, maximum: UNREAD_MAX_LIMIT, default: 20, description: 'Max items to return.' },
      },
    },
  },
  {
    name: 'rss_read',
    description:
      'Read one item from the inbox by id. Returns title, link and the stored summary text. With full:true it also downloads the article page and extracts the main text (needs a valid link; falls back to the stored summary on failure). Use it before telling the user details.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Item id from rss_unread, e.g. f_9k2x:https://example.com/post-1.' },
        full: { type: 'boolean', description: 'Fetch the article page and extract full text. Slower; use when the summary is not enough.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'rss_add',
    description:
      'Subscribe to a new RSS feed or update an existing one. The url may be the feed itself or a site homepage (the feed link is discovered automatically). The feed is fetched once to verify it parses; on failure nothing is saved and a diagnosis is returned. Existing items are marked as seen and not pushed, except the newest `baseline` items. Never add feeds without an explicit user request.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Site or feed URL, http(s).' },
        title: { type: 'string', description: 'Custom display name; defaults to the feed own title.' },
        notify: { type: 'string', enum: [...NOTIFY_MODES], description: 'notify pushes live (default); mute only fills the inbox and is never announced (digest or startup included).' },
        intervalMinutes: { type: 'integer', minimum: 0, maximum: 1440, description: 'Poll interval override in minutes; 0 uses the global default (min 1).' },
        userAgent: { type: 'string', description: 'Per-feed User-Agent override; empty uses the built-in Coopanion RSS Reader/<version> UA.' },
        fullText: { type: 'boolean', description: 'Allow rss_read(full) to fetch article pages for this feed. Default true.' },
        baseline: { type: 'integer', minimum: 0, maximum: 5, description: 'Push the newest N existing items as if new. Default 0 (history stays silent).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'rss_remove',
    description:
      'Unsubscribe one feed by id (from rss_list). Its stored items are deleted as well. Confirm with the user before calling.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        feedId: { type: 'string', description: 'Feed id from rss_list.' },
      },
      required: ['feedId'],
    },
  },
  {
    name: 'rss_mark',
    description:
      'Mark inbox items as read, unread, starred or unstarred. After telling the user about a batch of items, mark them read so the inbox does not pile up. Items the user defers should be starred instead.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ids: { type: 'array', items: { type: 'string' }, maxItems: MARK_MAX_KEYS, description: 'Item ids to mark. Omit with all:true or feedId.' },
        all: { type: 'boolean', description: 'Apply to every item matching feedId (or everything when omitted).' },
        feedId: { type: 'string', description: 'Restrict to one feed id when using all:true.' },
        status: { type: 'string', enum: ['read', 'unread', 'starred', 'unstarred'] },
      },
      required: ['status'],
    },
  },
  {
    name: 'rss_refresh',
    description:
      'Poll one feed (feedId) or all feeds right now, bypassing the schedule. Use it when the user asks for fresh updates. New eligible items are notified through the normal batched event a few seconds later.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        feedId: { type: 'string', description: 'One feed id; omit to refresh everything.' },
      },
    },
  },
];

export const RSS_SUMMARIES: Record<string, { zh: string; en: string }> = {
  rss_list: {
    zh: '列出全部订阅源与状态：策略、间隔、未读数、最近成功或错误。',
    en: 'Lists feed subscriptions with policy, interval, unread count and last success or error.',
  },
  rss_unread: {
    zh: '浏览收件箱：默认未读，可按源筛选、按关键词搜索，可看星标。',
    en: 'Browses the inbox: unread by default, filterable by feed and keyword, starred included.',
  },
  rss_read: {
    zh: '读一条条目的摘要；full 时抓原文页并抽取正文，取不到就回落摘要。',
    en: 'Reads one item; full:true fetches and extracts the article text, falling back to the summary.',
  },
  rss_add: {
    zh: '订阅一个源(站点或 RSS 地址都行),先试解析再入库；历史默认静默，可选推送最新几条。',
    en: 'Subscribes to a feed (site or RSS URL) after a test parse; history stays silent, newest N can be pushed.',
  },
  rss_remove: {
    zh: '退订一个源，其历史条目一并删除。',
    en: 'Unsubscribes one feed; its stored items are deleted as well.',
  },
  rss_mark: {
    zh: '把条目标为已读/未读/星标/取消星标。',
    en: 'Marks items read, unread, starred or unstarred.',
  },
  rss_refresh: {
    zh: '立即轮询一个或全部源，绕过排程。',
    en: 'Polls one feed or all feeds right now, bypassing the schedule.',
  },
};

export interface RssWorldOptions {
  cfg: RssConfigSection;
  timezone: string;
  dataDir: string;
  /** 面板 config.save 的写回通道(ctx.persist);缺省时只改内存。 */
  persist?: (patch: Partial<RssConfigSection>) => void;
  log?: { info(message: string): void; warn(message: string): void };
  fetchImpl?: FetchImpl;
  now?: () => Date;
}

interface UrlTestResult {
  feedUrl: string;
  parsed: ReturnType<typeof parseFeed>;
  discovered: boolean;
}

export class RssWorld implements World {
  readonly id = RSS_ID;

  /** 挂载前落到构造选项的日志；挂载后统一走 host.log(带 world 区域字段)。 */
  private readonly logger = {
    info: (message: string): void => {
      const host = this.host;
      if (host) host.log.info(message);
      else this.optionsLog.info(message);
    },
    warn: (message: string): void => {
      const host = this.host;
      if (host) host.log.warn(message);
      else this.optionsLog.warn(message);
    },
  };

  private readonly cfg: RssConfigSection;
  private readonly timezone: string;
  private readonly store: RssStore;
  private readonly poller: RssPoller;
  private host: WorldHost | null = null;
  /** 预览刚发出的一小段时间内,模型调用 rss_mark 只回执不落库;面板手动标记不受影响。 */
  private previewGuardUntil = 0;
  private readonly feedErrorLastAt = new Map<string, number>();
  private readonly optionsLog: { info(message: string): void; warn(message: string): void };
  private readonly persistCfg?: (patch: Partial<RssConfigSection>) => void;
  private readonly now: () => Date;
  private readonly injectedFetch: { fetchImpl?: FetchImpl };
  /** store 持有同一引用：config.save 改动即时反映到清理与入库预算。 */
  private readonly limits: StoreLimits;

  constructor(options: RssWorldOptions) {
    this.cfg = options.cfg;
    this.timezone = options.timezone;
    this.optionsLog = options.log ?? { info: () => {}, warn: () => {} };
    this.persistCfg = options.persist;
    this.now = options.now ?? (() => new Date());
    this.injectedFetch = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};
    // 共享的 limits 活对象：store 持有引用，config.save 改动即时生效(compact/addItems 现读)。
    this.limits = {
      ...DEFAULT_LIMITS,
      retentionDays: Math.max(3, Math.floor(this.cfg.retentionDays)),
      maxItemsTotal: Math.max(100, Math.floor(this.cfg.maxItemsTotal)),
      maxItemsPerFeed: Math.max(20, Math.floor(this.cfg.maxItemsPerFeed)),
    };
    this.store = new RssStore(options.dataDir, this.limits, { warn: (message) => this.logger.warn(message) });
    this.poller = new RssPoller({
      cfg: this.cfg,
      store: this.store,
      timezone: this.timezone,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.now ? { now: options.now } : {}),
      onBatch: (batch) => { void this.deliverBatch(batch); },
      onFeedError: (info) => this.deliverFeedError(info),
      onDigestDue: () => this.deliverDigest(),
      log: this.logger,
    });
  }

  // ── 事件 ────────────────────────────────────────────────────────────

  /** 合批缓冲到期：推送 rss.new_items。 */
  private async deliverBatch(batch: BatchEvent): Promise<void> {
    if (!this.host) return;
    try {
      await this.host.pushEvent({
        type: 'rss.new_items',
        ts: this.now().toISOString(),
        source: RSS_ID,
        origin: 'external',
        senderKey: 'rss.new_items',
        text: batch.text,
        meta: batch.meta,
      }, { trigger: 'debounce' });
      this.store.markNotified(batch.meta.itemKeys);
      if (this.cfg.autoMarkReadOnNotify) {
        this.store.markItems({ keys: batch.meta.itemKeys, status: 'read' });
      }
      this.store.flushNow();
    } catch (error) {
      this.logger.warn(`推送事件失败:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 源连续失败 ≥3 次：internal 事件，同一源 6 小时节流。 */
  private deliverFeedError(info: FeedErrorInfo): void {
    if (!this.host) return;
    const last = this.feedErrorLastAt.get(info.feedId) ?? 0;
    if (this.now().getTime() - last < 6 * 3600 * 1000) return;
    this.feedErrorLastAt.set(info.feedId, this.now().getTime());
    void this.host.pushEvent({
      type: 'rss.feed_error',
      ts: this.now().toISOString(),
      source: RSS_ID,
      origin: 'internal',
      senderKey: `rss.feed_error:${info.feedId}`,
      text: `「${info.feedTitle}」连续 ${info.consecutiveErrors} 次拉取失败(${info.code}):${info.hint}。`,
      meta: { feedId: info.feedId, code: info.code },
    }, { trigger: 'debounce' });
  }

  /** 晨报时刻：pushDeferred 投递时现算；当天没有内容则 render 返回 null,不投递。 */
  private deliverDigest(): void {
    if (!this.host) return;
    this.host.pushDeferred({
      type: 'rss.daily_digest',
      origin: 'internal',
      senderKey: 'rss.daily_digest',
      render: () => this.renderDigest(),
    }, { trigger: 'flush' });
  }

  private renderDigest(): string | null {
    const now = this.now();
    // 计数覆盖全库(含静默源):用户明确要求晨报统计包含静默数据。
    const fetched = this.store.countSince(24 * 3600 * 1000, now);
    const unread = this.store.unreadCount();
    if (fetched === 0 && unread === 0) return null;
    // 重点只列会播报的源(非静默),静默源内容永远不进入晨报正文。
    const broadcastIds = this.store.feeds().filter((feed) => feed.notify === 'notify').map((feed) => feed.id);
    const broadcastUnread = broadcastIds.reduce((sum, id) => sum + this.store.unreadCount(id), 0);
    const silentUnread = unread - broadcastUnread;
    const { items } = this.store.itemsQuery({ scope: 'unread', limit: 3, feedIds: broadcastIds });
    const lines = items.map((item) => {
      const feed = this.store.feed(item.feedId);
      return `① [${feed?.title ?? item.feedId}] ${item.title.slice(0, 80)}`;
    });
    const highlightLine = lines.length > 0
      ? `未读重点:\n${lines.join('\n')}`
      : silentUnread > 0
        ? `未读里暂时没有需要播报的条目(静默源的 ${silentUnread} 条只留在收件箱)。`
        : '没有积压的未读，收件箱是干净的。';
    const parts = [
      `RSS晨报：过去 24 小时收到 ${fetched} 条新内容，当前未读 ${unread} 条。`,
      highlightLine,
    ];
    return parts.join('\n');
  }

  // ── World 契约 ──────────────────────────────────────────────────────

  envPromptVars(): Record<string, string> {
    return {
      'rss.feedCount': String(this.store.feeds().length),
      'rss.digestTime': this.cfg.digestEnabled ? this.cfg.digestTime : 'off',
    };
  }

  tools(): ToolDef[] {
    return [
      { ...RSS_TOOL_DECLS[0], handler: async () => this.toolList() },
      { ...RSS_TOOL_DECLS[1], handler: async (args) => this.toolUnread(args) },
      { ...RSS_TOOL_DECLS[2], handler: async (args) => this.toolRead(args) },
      { ...RSS_TOOL_DECLS[3], handler: async (args) => this.toolAdd(args) },
      { ...RSS_TOOL_DECLS[4], handler: async (args) => this.toolRemove(args) },
      { ...RSS_TOOL_DECLS[5], handler: async (args) => this.toolMark(args) },
      { ...RSS_TOOL_DECLS[6], handler: async (args) => this.toolRefresh(args) },
    ];
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.feedErrorLastAt.clear();
    this.poller.start();
    // 启动播报:立即拉取全部未暂停源;refresh 结束会立刻合批推送(静默源已被过滤)。
    if (this.cfg.startupNotify) {
      void this.poller.refresh().catch((error) => {
        this.logger.warn(`启动刷新失败:${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  async stop(): Promise<void> {
    this.poller.stop();
    this.store.flushNow();
    this.host = null;
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = text(language);
    const failing = this.store.feeds().filter((feed) => feed.consecutiveErrors >= 3);
    return {
      label: t.moduleLabel,
      lamps: [
        {
          label: t.lampPoll,
          state: this.store.feeds().length === 0
            ? 'offline'
            : failing.length > 0 ? 'error' : 'online',
          hint: this.store.feeds().length === 0
            ? t.lampPollOffline
            : failing.length > 0 ? t.lampPollError(failing.length) : t.lampPollOnline,
        },
        {
          label: t.lampInbox,
          state: 'online',
          hint: t.unreadBadge(this.store.unreadCount()),
        },
      ],
      // 配置不进内建「配置」标签：旋钮按主题做成下面的自定义面板(标签),保存走 config.save。
      panels: [
        { id: 'feeds', title: t.tabFeeds, description: t.feedsSheetDesc },
        { id: 'inbox', title: t.tabInbox, description: t.inboxSheetDesc },
        { id: 'notify', title: t.tabNotify, description: t.tabNotifyDesc },
        { id: 'settings', title: t.tabSettings, description: t.tabSettingsDesc },
        { id: 'opml', title: t.tabOpml, description: t.opmlSheetDesc },
      ],
      invoke: (panel, method, args) => this.invokePanel(panel, method, args),
      promptDocs: [
        {
          key: `worlds.${RSS_ID}.envPrompt`,
          title: t.promptDocTitle,
          description: t.promptDocDescription,
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'rss.feedCount', description: '当前订阅源数量。' },
            { name: 'rss.digestTime', description: '每日晨报时刻，off 表示关闭。' },
          ],
        },
      ],
    };
  }

  // ── 共享操作(工具与面板共用) ────────────────────────────────────────

  /** 测试一个地址：feed 直接解析；站点页自动发现 <link rel="alternate">。 */
  async testUrl(rawUrl: string): Promise<UrlTestResult> {
    const url = rawUrl.trim();
    if (!url) throw new FetchFailure('scheme', '地址为空');
    const first = await fetchText({
      url,
      timeoutMs: Math.max(3_000, this.cfg.requestTimeoutMs),
      maxBytes: 2 * 1024 * 1024,
      userAgent: DEFAULT_USER_AGENT,
      ...(this.depsFetchOptions()),
    });
    if (first.status === 304) throw new FetchFailure('http', '源返回 304，但没有可解析的内容');
    const trimmed = first.body.trimStart();
    if (trimmed.startsWith('{') || /^<\?xml|<(rss|feed|rdf:RDF)\b/i.test(trimmed.slice(0, 200))) {
      return { feedUrl: first.finalUrl, parsed: parseFeed(first.body), discovered: false };
    }
    // 站点页：发现候选 feed 链接，逐个试。
    const candidates = discoverFeedsInHtml(first.body, first.finalUrl);
    let lastError: unknown = new FetchFailure('parse', '页面里没有发现 RSS/Atom 链接');
    for (const candidate of candidates) {
      try {
        const next = await fetchText({
          url: candidate,
          timeoutMs: Math.max(3_000, this.cfg.requestTimeoutMs),
          maxBytes: 2 * 1024 * 1024,
          userAgent: DEFAULT_USER_AGENT,
          ...(this.depsFetchOptions()),
        });
        const parsed = parseFeed(next.body);
        return { feedUrl: next.finalUrl, parsed, discovered: true };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private depsFetchOptions(): { fetchImpl?: FetchImpl } {
    return this.injectedFetch;
  }

  /** 订阅或更新；成功即做首次拉取并按 baseline 处理历史。 */
  async addFeed(input: {
    url: string;
    title?: string;
    notify?: string;
    intervalMinutes?: number;
    baseline?: number;
    userAgent?: string;
    fullText?: boolean;
  }): Promise<{ feed: FeedRecord; itemCount: number; discovered: boolean; created: boolean }> {
    const url = input.url.trim();
    if (!url) throw new Error('地址为空');
    const notify = ((): StoreNotifyMode => {
      if (input.notify == null || input.notify === '') return 'notify';
      if (!(NOTIFY_MODES as readonly string[]).includes(input.notify)) {
        throw new Error(`notify 必须是 ${NOTIFY_MODES.join('/')} 之一`);
      }
      return input.notify as StoreNotifyMode;
    })();
    const test = await this.testUrl(url);
    const existing = this.store.feedByUrl(test.feedUrl) ?? this.store.feedByUrl(url);
    if (existing) {
      this.store.updateFeed(existing.id, {
        ...(input.title ? { title: input.title } : {}),
        notify,
        ...(input.intervalMinutes != null ? { intervalMinutes: Math.max(0, Math.floor(input.intervalMinutes)) } : {}),
        ...(input.userAgent != null ? { userAgent: input.userAgent } : {}),
        ...(input.fullText != null ? { fullText: input.fullText } : {}),
      });
      const updated = this.store.feed(existing.id)!;
      this.store.flushNow();
      return { feed: updated, itemCount: this.store.unreadCount(existing.id), discovered: test.discovered, created: false };
    }
    const capacity = Math.max(1, Math.floor(this.cfg.maxFeeds));
    if (this.store.feeds().length >= capacity) {
      throw new Error(`订阅已达容量上限 ${capacity},先退订一些再加`);
    }
    const feed = this.store.createFeed({
      url: test.feedUrl,
      title: input.title?.trim() || test.parsed.title || test.feedUrl,
      notify,
      ...(input.intervalMinutes != null ? { intervalMinutes: Math.max(0, Math.floor(input.intervalMinutes)) } : {}),
      ...(input.userAgent != null ? { userAgent: input.userAgent } : {}),
      fullText: input.fullText !== false,
    });
    // 首次拉取：历史静默，最新 baseline 条当作新消息(baseline 默认 0)。
    const baseline = Math.max(0, Math.min(5, Math.floor(input.baseline ?? 0)));
    const adopted = await this.poller.adoptFeed(feed, baseline, this.cfg.baselineAsRead !== false);
    if (adopted.status === 'error') {
      // 首拉失败也保留订阅(站点可能临时抖动),但如实报告。
      this.store.flushNow();
      return { feed: this.store.feed(feed.id)!, itemCount: 0, discovered: test.discovered, created: true };
    }
    this.store.flushNow();
    return { feed: this.store.feed(feed.id)!, itemCount: adopted.freshCount, discovered: test.discovered, created: true };
  }

  removeFeedById(id: string, purge: boolean): { title: string; itemsPurged: number } {
    const { feed, itemsPurged } = this.store.removeFeed(id, purge);
    this.store.flushNow();
    return { title: feed.title, itemsPurged };
  }

  // ── 工具 handler ────────────────────────────────────────────────────

  private toolList(): string {
    const feeds = this.store.feeds();
    if (feeds.length === 0) {
      return `当前没有订阅源。用 rss_add 添加(站点或 RSS 地址都可以)。`;
    }
    const now = this.now();
    const unreadTotal = this.store.unreadCount();
    const lines = feeds.map((feed) => {
      const t = text('zh');
      const unread = this.store.unreadCount(feed.id);
      const policy = t.notifyBadge[feed.notify as StoreNotifyMode] ?? feed.notify;
      const interval = feed.intervalMinutes > 0 ? `每${feed.intervalMinutes}分` : '默认间隔';
      const state = feed.paused
        ? '已暂停'
        : feed.lastError && feed.consecutiveErrors > 0
          ? `错误×${feed.consecutiveErrors}:${feed.lastError}`
          : `正常(${relativeTime(feed.lastOkAt, now, 'zh')})`;
      return `· ${feed.id} ${feed.title} [${policy}] ${interval} · 未读${unread} · ${state}`;
    });
    const header = `订阅 ${feeds.length} 个源，共未读 ${unreadTotal} 条:`;
    return clip(`${header}\n${lines.join('\n')}`, LIST_RECEIPT_CHARS);
  }

  private toolUnread(args: Record<string, unknown>): string {
    const feedId = typeof args.feedId === 'string' ? args.feedId : undefined;
    if (feedId && !this.store.feed(feedId)) {
      return `没有 id 为 ${feedId} 的源；用 rss_list 查看现有源。`;
    }
    const scope = (['unread', 'all', 'starred'] as const).find((s) => s === args.scope) ?? 'unread';
    const limit = Math.max(1, Math.min(UNREAD_MAX_LIMIT, typeof args.limit === 'number' ? Math.floor(args.limit) : 20));
    const { total, items } = this.store.itemsQuery({
      ...(feedId ? { feedId } : {}),
      scope,
      ...(typeof args.query === 'string' ? { query: args.query } : {}),
      limit,
    });
    if (total === 0) {
      return scope === 'starred' ? '还没有星标条目。' : `收件箱没有${scope === 'unread' ? '未读' : ''}内容${feedId ? `(源 ${feedId})` : ''}。`;
    }
    const now = this.now();
    const feeds = new Map(this.store.feeds().map((feed) => [feed.id, feed.title]));
    const lines = items.map((item, index) => {
      const feedTitle = feeds.get(item.feedId) ?? item.feedId;
      const flags = [item.starred ? '★' : '', !item.read ? '' : '已读'].filter(Boolean).join(' ');
      const summary = item.plain.replace(/\s+/g, ' ').slice(0, 60);
      return `${index + 1}. [${feedTitle}] ${item.title.slice(0, 80)}${flags ? ` ${flags}` : ''} · ${relativeTime(item.publishedAt, now, 'zh')}`
        + `\n   id: ${item.key}${summary ? `\n   ${summary}` : ''}`;
    });
    const header = `${scope === 'unread' ? '未读' : scope === 'starred' ? '星标' : '全部'} ${total} 条(显示 ${items.length}):`;
    return clip(`${header}\n${lines.join('\n')}\n用 rss_read(id) 看详情。`, UNREAD_RECEIPT_CHARS);
  }

  private async toolRead(args: Record<string, unknown>): Promise<string> {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return '缺少 id:先用 rss_unread 拿条目 id。';
    const item = this.store.item(id);
    if (!item) return `找不到条目 ${id};可能已被清理或 id 抄错了，用 rss_unread 重新拿。`;
    const feed = this.store.feed(item.feedId);
    const now = this.now();
    const header = `[${feed?.title ?? item.feedId}] ${item.title || '(无标题)'}`
      + `\n链接: ${item.url || '(无)'} · 发布: ${relativeTime(item.publishedAt, now, 'zh')}(${item.publishedAt.slice(0, 16).replace('T', ' ')})`
      + (item.author ? `\n作者: ${item.author}` : '')
      + (item.enclosure ? `\n附件: ${item.enclosure.mime} ${item.enclosure.url}` : '');

    if (args.full === true) {
      if (feed && feed.fullText === false) {
        return `${header}\n\n这个订阅关闭了全文抓取(在订阅详情里打开),只给库内摘要:\n${clip(item.plain || '(空)', READ_RECEIPT_CHARS - header.length - 40)}`;
      }
      if (item.fullText && item.fullTextAt && now.getTime() - new Date(item.fullTextAt).getTime() <= FULLTEXT_TTL_MS) {
        return `${header}\n\n正文(缓存,${item.fullText.length} 字符):\n${clip(item.fullText, READ_RECEIPT_CHARS - header.length - 40)}`;
      }
      if (!item.url || !/^https?:\/\//i.test(item.url)) {
        return `${header}\n\n这条没有可抓取的原文链接，只给库内摘要:\n${clip(item.plain || '(空)', READ_RECEIPT_CHARS - header.length - 40)}`;
      }
      try {
        const page = await fetchText({
          url: item.url,
          timeoutMs: Math.max(3_000, this.cfg.requestTimeoutMs),
          maxBytes: ARTICLE_BYTES,
          userAgent: (feed?.userAgent || DEFAULT_USER_AGENT),
          ...this.injectedFetch,
        });
        const { text: article } = extractArticle(page.body, READ_RECEIPT_CHARS - header.length - 200);
        if (article.length < 80) throw new Error('抽取到的正文太短');
        this.store.setItemFullText(item.key, article, now);
        this.store.flushNow();
        return `${header}\n\n正文(已抓原文,${article.length} 字符):\n${article}`;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return `${header}\n\n抓取原文失败(${reason}),回落库内摘要:\n${clip(item.plain || '(空)', READ_RECEIPT_CHARS - header.length - 60)}`;
      }
    }
    return `${header}\n\n摘要:\n${clip(item.plain || '(库内没有摘要；试 full:true 抓原文)', READ_RECEIPT_CHARS - header.length - 40)}`;
  }

  private async toolAdd(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!url) return '缺少 url:给站点首页或 RSS 地址都可以。';
    try {
      const result = await this.addFeed({
        url,
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
        ...(typeof args.notify === 'string' ? { notify: args.notify } : {}),
        ...(typeof args.intervalMinutes === 'number' ? { intervalMinutes: args.intervalMinutes } : {}),
        ...(typeof args.userAgent === 'string' ? { userAgent: args.userAgent } : {}),
        ...(typeof args.fullText === 'boolean' ? { fullText: args.fullText } : {}),
        ...(typeof args.baseline === 'number' ? { baseline: args.baseline } : {}),
      });
      const feed = result.feed;
      const { items } = this.store.itemsQuery({ feedId: feed.id, scope: 'all', limit: 3 });
      const preview = items.map((item, i) => `${['①', '②', '③'][i]} ${item.title.slice(0, 60) || '(无标题)'}`);
      const lines = [
        `${result.created ? '已订阅' : '已更新'}「${feed.title}」(${feed.id}),策略 ${feed.notify},间隔 ${feed.intervalMinutes > 0 ? `${feed.intervalMinutes} 分钟` : '默认'}。`,
        result.discovered ? '(地址是站点首页，已自动发现 feed)' : '',
        items.length > 0 ? `最新 ${items.length} 条:\n${preview.join('\n')}` : '(源里暂时没有条目)',
        result.created ? `历史条目已标记为已见，不会打扰用户。` : '',
      ].filter(Boolean);
      return clip(lines.join('\n'), ACTION_RECEIPT_CHARS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ParseError) {
        return { text: `订阅失败:${message}。可以确认一下地址，或直接找 RSS 链接再试。`, failed: true };
      }
      return { text: `订阅失败:${message}`, failed: true };
    }
  }

  private toolRemove(args: Record<string, unknown>): string {
    const feedId = typeof args.feedId === 'string' ? args.feedId.trim() : '';
    if (!feedId) return '缺少 feedId:先用 rss_list 查源 id。';
    const feed = this.store.feed(feedId);
    if (!feed) return `没有 id 为 ${feedId} 的源；用 rss_list 查看现有源。`;
    // 退订即删除：源与其历史条目一并移除，不做保留。
    const { title, itemsPurged } = this.removeFeedById(feedId, true);
    return `已退订「${title}」，其 ${itemsPurged} 条历史条目已一并删除。`;
  }

  private toolMark(args: Record<string, unknown>): string {
    const status = (['read', 'unread', 'starred', 'unstarred'] as const).find((s) => s === args.status);
    if (!status) return 'status 必须是 read/unread/starred/unstarred。';
    const keys = Array.isArray(args.ids) ? args.ids.filter((k): k is string => typeof k === 'string').slice(0, MARK_MAX_KEYS) : null;
    const all = args.all === true;
    const feedId = typeof args.feedId === 'string' ? args.feedId : undefined;
    if (!keys && !all) return '给出要标记的条目 ids,或 all:true(可配合 feedId)。';
    if (keys && keys.length === 0) return 'ids 是空的；用 rss_unread 拿条目 id。';
    if (feedId && !this.store.feed(feedId)) return `没有 id 为 ${feedId} 的源。`;
    if (this.now().getTime() < this.previewGuardUntil) {
      return '当前是播报预览,不会修改已读状态;预览结束后再标记。';
    }
    const changed = this.store.markItems({
      ...(keys ? { keys } : {}),
      ...(feedId ? { feedId } : {}),
      all: all || (!keys && !feedId),
      status,
    });
    this.store.flushNow();
    const label = { read: '已读', unread: '未读', starred: '星标', unstarred: '取消星标' }[status];
    return changed > 0 ? `已把 ${changed} 条标为${label}。` : `没有需要改动的条目(可能已${label})。`;
  }

  private async toolRefresh(args: Record<string, unknown>): Promise<string> {
    const feedId = typeof args.feedId === 'string' ? args.feedId.trim() : undefined;
    if (feedId && !this.store.feed(feedId)) return `没有 id 为 ${feedId} 的源；用 rss_list 查看现有源。`;
    const outcomes = await this.poller.refresh(feedId ? [feedId] : undefined);
    if (outcomes.length === 0) return feedId ? `源 ${feedId} 已暂停或不存在。` : '没有可刷新的源。';
    const lines = outcomes.map((outcome) => {
      if (!outcome.ok) return `· ${outcome.feedTitle}:失败(${outcome.error ?? '未知错误'})`;
      if (outcome.notModified) return `· ${outcome.feedTitle}:无更新(304)`;
      return `· ${outcome.feedTitle}:新 ${outcome.newCount} 条`;
    });
    return clip(`已刷新 ${outcomes.length} 个源:\n${lines.join('\n')}`, ACTION_RECEIPT_CHARS);
  }

  // ── 面板数据面 ──────────────────────────────────────────────────────

  /** 面板数据面：按 method 分发(面板只是标签，方法全页共享，与 dsh-bridge 同款)。 */
  private async invokePanel(panel: string, method: string, args: unknown[]): Promise<unknown> {
    void panel;
    const first = Array.isArray(args) ? args[0] : undefined;
    switch (method) {
      case 'config.get': {
        const keys = RSS_CONFIG_KEYS;
        const out: Record<string, unknown> = {};
        for (const key of keys) out[key] = this.cfg[key];
        return out;
      }
      case 'config.save': {
        const { patch, restartRequired } = sanitizeConfigPatch(first, this.cfg);
        // cfg 是活引用：逐字段写入，轮询/通知侧按现读生效。
        const writable = this.cfg as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(patch)) {
          writable[key] = value;
        }
        // 清理预算是共享 limits 活对象，同步后 compact/addItems 立即按新值执行。
        for (const key of ['retentionDays', 'maxItemsTotal', 'maxItemsPerFeed'] as const) {
          if (key in patch) this.limits[key] = patch[key] as number;
        }
        this.persistCfg?.(patch);
        return { ok: true, restartRequired, applied: Object.keys(patch) };
      }
      case 'overview':
        return {
          feeds: this.store.feeds().length,
          unread: this.store.unreadCount(),
          fetched24h: this.store.countSince(24 * 3600 * 1000, this.now()),
          failing: this.store.feeds().filter((feed) => feed.consecutiveErrors >= 3).map((feed) => ({ id: feed.id, title: feed.title, error: feed.lastError })),
          defaultUserAgent: DEFAULT_USER_AGENT,
          limits: {
            retentionDays: this.limits.retentionDays,
            maxItemsTotal: this.limits.maxItemsTotal,
            maxItemsPerFeed: this.limits.maxItemsPerFeed,
          },
        };
      case 'feeds.list':
        return this.store.feeds().map((feed) => ({ ...feed, unread: this.store.unreadCount(feed.id) }));
      case 'feeds.test': {
        const input = (first ?? {}) as Record<string, unknown>;
        const url = typeof input.url === 'string' ? input.url : '';
        const test = await this.testUrl(url);
        return {
          ok: true,
          feedUrl: test.feedUrl,
          title: test.parsed.title,
          discovered: test.discovered,
          sample: test.parsed.items.slice(0, 3).map((item) => item.title),
          total: test.parsed.items.length,
        };
      }
      case 'feeds.add': {
        const input = (first ?? {}) as Record<string, unknown>;
        const result = await this.addFeed({
          url: String(input.url ?? ''),
          ...(typeof input.title === 'string' ? { title: input.title } : {}),
          ...(typeof input.notify === 'string' ? { notify: input.notify } : {}),
          ...(typeof input.intervalMinutes === 'number' ? { intervalMinutes: input.intervalMinutes } : {}),
          ...(typeof input.userAgent === 'string' ? { userAgent: input.userAgent } : {}),
          ...(typeof input.fullText === 'boolean' ? { fullText: input.fullText } : {}),
        });
        return { ok: true, id: result.feed.id, title: result.feed.title, created: result.created, itemCount: result.itemCount };
      }
      case 'feeds.update': {
        const input = (first ?? {}) as Record<string, unknown>;
        const id = String(input.id ?? '');
        const patch = (input.patch ?? {}) as Record<string, unknown>;
        const updated = this.store.updateFeed(id, {
          ...(typeof patch.title === 'string' ? { title: patch.title } : {}),
          ...(typeof patch.notify === 'string' ? { notify: patch.notify as StoreNotifyMode } : {}),
          ...(typeof patch.intervalMinutes === 'number' ? { intervalMinutes: patch.intervalMinutes } : {}),
          ...(typeof patch.paused === 'boolean' ? { paused: patch.paused } : {}),
          ...(typeof patch.weight === 'number' ? { weight: patch.weight } : {}),
          ...(typeof patch.userAgent === 'string' ? { userAgent: patch.userAgent } : {}),
          ...(typeof patch.fullText === 'boolean' ? { fullText: patch.fullText } : {}),
        });
        if (!updated) throw new Error(`unknown feed: ${id}`);
        this.store.flushNow();
        return { ok: true };
      }
      case 'feeds.remove': {
        const input = (first ?? {}) as Record<string, unknown>;
        // 退订即删除：源与历史条目一并移除。
        const result = this.removeFeedById(String(input.id ?? ''), true);
        return { ok: true, ...result };
      }
      case 'feeds.refresh': {
        // 手动拉取：绕过排程立即轮询；新条目照常进合批缓冲，几秒内推送。
        const input = (first ?? {}) as Record<string, unknown>;
        const feedId = typeof input.id === 'string' && input.id ? input.id : undefined;
        if (feedId && !this.store.feed(feedId)) throw new Error(`unknown feed: ${feedId}`);
        const outcomes = await this.poller.refresh(feedId ? [feedId] : undefined);
        return {
          ok: true,
          results: outcomes.map((outcome) => ({
            feedId: outcome.feedId,
            feedTitle: outcome.feedTitle,
            ok: outcome.ok,
            newCount: outcome.newCount,
            notModified: outcome.notModified,
            error: outcome.error,
          })),
        };
      }
      case 'items.list': {
        const input = (first ?? {}) as Record<string, unknown>;
        const query = this.store.itemsQuery({
          scope: (['unread', 'all', 'starred'] as const).find((s) => s === input.scope) ?? 'unread',
          ...(typeof input.feedId === 'string' ? { feedId: String(input.feedId) } : {}),
          ...(typeof input.query === 'string' && input.query.trim() ? { query: input.query } : {}),
          limit: typeof input.limit === 'number' ? Math.floor(input.limit) : 50,
          ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
        });
        return {
          total: query.total,
          items: query.items.map((item) => ({
            key: item.key,
            feedId: item.feedId,
            feedTitle: this.store.feed(item.feedId)?.title ?? item.feedId,
            title: item.title,
            url: item.url,
            publishedAt: item.publishedAt,
            read: item.read,
            starred: item.starred,
          })),
        };
      }
      case 'items.clear': {
        // 两种模式：带 ids = 删除勾选的条目(明确意图，星标也删);否则按范围+源清空。
        const input = (first ?? {}) as Record<string, unknown>;
        const ids = Array.isArray(input.ids)
          ? input.ids.filter((k): k is string => typeof k === 'string')
          : undefined;
        if (ids) {
          const cleared = this.store.deleteItems(ids);
          this.store.flushNow();
          return { ok: true, cleared };
        }
        const feedId = typeof input.feedId === 'string' && input.feedId ? input.feedId : undefined;
        if (feedId && !this.store.feed(feedId)) throw new Error(`unknown feed: ${feedId}`);
        const scope = (['unread', 'all', 'starred'] as const).find((s) => s === input.scope) ?? 'all';
        const cleared = this.store.clearItems({ ...(feedId ? { feedId } : {}), scope });
        this.store.flushNow();
        return { ok: true, cleared };
      }
      case 'items.mark': {
        const input = (first ?? {}) as Record<string, unknown>;
        const status = (['read', 'unread', 'starred', 'unstarred'] as const).find((s) => s === input.status);
        if (!status) throw new Error('status 必须是 read/unread/starred/unstarred');
        const keys = Array.isArray(input.ids) ? input.ids.filter((k): k is string => typeof k === 'string') : null;
        const changed = this.store.markItems({
          ...(keys ? { keys } : {}),
          all: keys == null,
          status,
        });
        this.store.flushNow();
        return { ok: true, changed };
      }
      case 'notify.preview': {
        const input = (first ?? {}) as Record<string, unknown>;
        const kind = input.kind === 'digest' ? 'digest' : 'live';
        let text: string | null = null;
        let fallback = false;
        let total = 0;
        let dropped = 0;
        if (kind === 'digest') {
          text = this.renderDigest();
        } else {
          const preview = this.poller.previewBatch();
          if (preview) {
            text = preview.text;
            total = preview.meta.total;
            dropped = preview.meta.dropped;
          } else {
            const recent = this.poller.previewRecentBatch(3);
            text = recent?.text ?? null;
            total = recent?.meta.total ?? 0;
            dropped = recent?.meta.dropped ?? 0;
            fallback = true;
          }
        }
        if (!text) return { kind, sent: false, text: null, fallback, total, dropped };
        if (!this.host) return { kind, sent: false, text, fallback, total, dropped };
        // 预览不在面板里展示:推给 Coo,让它用 pet_say 在桌宠气泡里模拟真实播报。
        await this.host.pushEvent({
          type: 'rss.new_items',
          ts: this.now().toISOString(),
          source: RSS_ID,
          origin: 'external',
          senderKey: 'rss.new_items',
          text,
          meta: { kind, total, dropped, fallback },
        }, { trigger: 'flush' });
        this.previewGuardUntil = this.now().getTime() + 60_000;
        return { kind, sent: true, text, fallback, total, dropped };
      }
      case 'opml.export':
        return { opml: exportOpml(this.store.feeds()) };
      case 'opml.import': {
        const input = (first ?? {}) as Record<string, unknown>;
        const xml = typeof input.opml === 'string' ? input.opml : '';
        const entries = parseOpml(xml);
        let ok = 0;
        let fail = 0;
        for (const entry of entries.slice(0, Math.max(0, this.cfg.maxFeeds - this.store.feeds().length))) {
          try {
            await this.addFeed({ url: entry.url, title: entry.title });
            ok += 1;
          } catch {
            fail += 1;
          }
        }
        this.store.flushNow();
        return { ok, fail, skipped: entries.length - ok - fail, total: entries.length };
      }
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }
}

/** describe.json 的生成与校验共用；events 一并从这里取。 */
export const RSS_EVENT_DESCS = [
  {
    type: 'rss.new_items',
    description: {
      zh: '合批后的新内容摘要：源名 + 标题 + 一句话摘要，默认最多 8 条。',
      en: 'Batched digest of new items: feed title, headline and one-line summary, up to 8.',
    },
  },
  {
    type: 'rss.feed_error',
    description: {
      zh: '某个源连续 3 次拉取失败，附诊断建议；同一源 6 小时内不重复。',
      en: 'A feed failed three times in a row with a diagnostic hint; throttled to once per 6h per feed.',
    },
  },
  {
    type: 'rss.daily_digest',
    description: {
      zh: '每日晨报：过去 24 小时全库收件统计与未读计数(含静默源)，并列最多 3 条非静默源的未读重点；当天没有内容就不发。',
      en: 'Daily digest: last-24h counts across all feeds (muted included), plus up to 3 unread highlights from non-muted feeds.',
    },
  },
] as const;
