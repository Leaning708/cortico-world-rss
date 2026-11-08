/**
 * 轮询引擎:单队列按 nextPollAt 出队、并发上限、指数退避、条件请求、事件合批。
 * 世界回调(onBatch/onFeedError/onDigestDue)由 world.ts 接线到 host.pushEvent。
 * 定时器与 now 可注入,测试不 sleep。
 */
import type { RssConfigSection } from './config.ts';
import { nextOccurrenceOfDayTime, parseHm } from './chrono.ts';
import { fetchText, FetchFailure } from './fetcher.ts';
import { parseFeed } from './parse.ts';
import type { FeedRecord, ItemRecord, RssStore } from './store.ts';
import { DEFAULT_USER_AGENT } from './version.ts';

/** 退避阶梯(分钟);索引按连续失败次数递增,封顶后保持。 */
export const BACKOFF_MINUTES = [5, 10, 20, 60, 180, 360] as const;

export interface BatchEvent {
  text: string;
  meta: {
    feedIds: string[];
    itemKeys: string[];
    total: number;
    dropped: number;
  };
}

export interface FeedErrorInfo {
  feedId: string;
  feedTitle: string;
  code: string;
  consecutiveErrors: number;
  hint: string;
}

export interface RefreshOutcome {
  feedId: string;
  feedTitle: string;
  ok: boolean;
  newCount: number;
  notModified: boolean;
  error: string | null;
}

export interface PollerDeps {
  cfg: RssConfigSection;
  store: RssStore;
  timezone: string;
  /** 整条 fetchText 替换(测试);与 fetchImpl 二选一。 */
  fetchText?: typeof fetchText;
  /** 注入底层 fetch(测试);默认真实网络。 */
  fetchImpl?: import('./fetcher.ts').FetchImpl;
  now?: () => Date;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onBatch?: (batch: BatchEvent) => void;
  onFeedError?: (info: FeedErrorInfo) => void;
  onDigestDue?: () => void;
  log?: { info(message: string): void; warn(message: string): void };
}

interface BufferedEntry {
  feedId: string;
  feedTitle: string;
  item: ItemRecord;
  score: number;
  enqueuedAt: number;
}

type PollResult = { status: 'ok' | 'not-modified' | 'error'; freshCount: number };

/** 机械打分:源权重 + 新鲜度。只决定事件内顺序,不判断"重要性"。 */
function scoreItem(feed: FeedRecord, item: ItemRecord, now: Date): number {
  let score = feed.weight;
  const ageHours = (now.getTime() - new Date(item.publishedAt).getTime()) / 3600_000;
  if (ageHours < 1) score += 2;
  return score;
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩',
  '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];

export class RssPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly buffer: BufferedEntry[] = [];
  private lastDigestFiredAt = 0;
  private readonly fetchTextImpl: typeof fetchText;
  private readonly now: () => Date;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly log: { info(message: string): void; warn(message: string): void };

  constructor(private readonly deps: PollerDeps) {
    this.fetchTextImpl = deps.fetchText
      ?? (deps.fetchImpl ? (options) => fetchText({ ...options, fetchImpl: deps.fetchImpl }) : fetchText);
    this.now = deps.now ?? (() => new Date());
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
    this.log = deps.log ?? { info: () => {}, warn: () => {} };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // 启动错峰:没有排程的源加随机延迟,避免一次启用 50 个源同时开轮。
    const now = this.now();
    for (const feed of this.deps.store.feeds()) {
      if (feed.paused) continue;
      if (feed.nextPollAt && new Date(feed.nextPollAt).getTime() > now.getTime() - 60_000) continue;
      const stagger = Math.floor(Math.random() * Math.min(this.intervalOf(feed), 5) * 60_000);
      feed.nextPollAt = new Date(now.getTime() + stagger).toISOString();
    }
    this.deps.store.flushNow();
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  /** 单源间隔:feed 覆盖优先,全局默认兜底;下限 1 分钟。 */
  private intervalOf(feed: FeedRecord): number {
    const global = Math.max(1, Math.floor(this.deps.cfg.pollIntervalMinutes));
    return feed.intervalMinutes > 0 ? Math.max(1, feed.intervalMinutes) : global;
  }

  pendingBatchSize(): number {
    return this.buffer.length;
  }

  /** 排下一次 tick:取最近的截止时刻,至多看 30s 远,保证配置热改能被看到。 */
  private scheduleNext(): void {
    if (!this.running) return;
    const now = this.now().getTime();
    let due = Infinity;
    for (const feed of this.deps.store.feeds()) {
      if (feed.paused) continue;
      const ts = feed.nextPollAt ? new Date(feed.nextPollAt).getTime() : Infinity;
      if (ts < due) due = ts;
    }
    const oldestBuffered = this.buffer.length > 0
      ? Math.min(...this.buffer.map((entry) => entry.enqueuedAt))
        + Math.max(5, this.deps.cfg.eventBatchSeconds) * 1000
      : Infinity;
    const digest = this.digestDueAt() ?? Infinity;
    const wait = Math.max(250, Math.min(due, oldestBuffered, digest, now + 30_000) - now);
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = this.setTimeoutFn(() => { void this.tick(); }, wait);
  }

  private digestDueAt(): number | null {
    const cfg = this.deps.cfg;
    if (!cfg.digestEnabled) return null;
    const minute = parseHm(cfg.digestTime);
    if (minute == null) return null;
    return nextOccurrenceOfDayTime(minute, this.deps.timezone, this.now()).getTime();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.runDuePolls();
      this.flushBatchIfDue();
      this.maybeFireDigest();
    } catch (error) {
      this.log.warn(`tick 异常:${error instanceof Error ? error.message : String(error)}`);
    }
    this.deps.store.flushNow();
    this.scheduleNext();
  }

  private async runDuePolls(): Promise<void> {
    const now = this.now();
    const due = this.deps.store.feeds().filter((feed) =>
      !feed.paused && feed.nextPollAt != null && new Date(feed.nextPollAt).getTime() <= now.getTime());
    if (due.length === 0) return;
    const concurrency = Math.max(1, Math.min(8, Math.floor(this.deps.cfg.pollConcurrency)));
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, due.length) }, async () => {
      while (index < due.length) {
        const feed = due[index];
        index += 1;
        await this.pollFeed(feed);
      }
    });
    await Promise.all(workers);
    this.deps.store.compact(now);
  }

  /** 拉一个源:条件请求 → 解析 → 入库 → 合格条目进合批缓冲;状态与退避写回。 */
  private async pollFeed(feed: FeedRecord, opts: { silentError?: boolean; baseline?: number; baselineAsRead?: boolean } = {}): Promise<PollResult> {
    const cfg = this.deps.cfg;
    const now = this.now();
    this.deps.store.setPollState(feed.id, { lastFetchAt: now.toISOString() });
    try {
      const result = await this.fetchTextImpl({
        url: feed.url,
        timeoutMs: Math.max(3_000, cfg.requestTimeoutMs),
        maxBytes: 2 * 1024 * 1024,
        userAgent: feed.userAgent || DEFAULT_USER_AGENT,
        etag: feed.etag,
        lastModified: feed.lastModified,
      });

      if (result.status === 304) {
        this.deps.store.setPollState(feed.id, {
          lastOkAt: now.toISOString(),
          lastError: null,
          consecutiveErrors: 0,
          backoffIndex: 0,
          nextPollAt: this.nextPollTime(feed),
        });
        return { status: 'not-modified', freshCount: 0 };
      }

      const parsed = parseFeed(result.body);
      const { fresh } = this.deps.store.addItems(feed, parsed.items, now, opts.baseline != null
        ? { baselineMarkSeen: true, baselineNotifyCount: opts.baseline, baselineAsRead: opts.baselineAsRead }
        : undefined);
      // baseline 模式:仅未被静默标记的条目(最新 N 条)才进缓冲。
      const toEnqueue = opts.baseline != null ? fresh.filter((item) => !item.notified) : fresh;
      for (const item of toEnqueue) {
        this.enqueueEligible(feed, item, now);
      }
      this.deps.store.setPollState(feed.id, {
        ...(result.etag || result.lastModified
          ? { etag: result.etag, lastModified: result.lastModified }
          : {}),
        lastOkAt: now.toISOString(),
        lastError: null,
        consecutiveErrors: 0,
        backoffIndex: 0,
        nextPollAt: this.nextPollTime(feed),
      });
      return { status: 'ok', freshCount: fresh.length };
    } catch (error) {
      const fetchFailure = error instanceof FetchFailure ? error : null;
      const message = fetchFailure
        ? fetchFailure.message
        : `解析失败:${error instanceof Error ? error.message : String(error)}`;
      const consecutive = feed.consecutiveErrors + 1;
      const backoffIndex = Math.min(consecutive - 1, BACKOFF_MINUTES.length - 1);
      let waitMinutes: number = BACKOFF_MINUTES[backoffIndex];
      if (fetchFailure?.retryAfterMs != null) {
        waitMinutes = Math.max(waitMinutes, Math.ceil(fetchFailure.retryAfterMs / 60_000));
      }
      this.deps.store.setPollState(feed.id, {
        lastError: message,
        consecutiveErrors: consecutive,
        backoffIndex,
        nextPollAt: new Date(now.getTime() + waitMinutes * 60_000).toISOString(),
      });
      if (consecutive >= 3 && !opts.silentError) {
        this.deps.onFeedError?.({
          feedId: feed.id,
          feedTitle: feed.title,
          code: fetchFailure ? `${fetchFailure.kind}${fetchFailure.status ? ` ${fetchFailure.status}` : ''}` : 'parse',
          consecutiveErrors: consecutive,
          hint: this.errorHint(fetchFailure?.kind ?? 'parse', fetchFailure?.status),
        });
      }
      this.log.warn(`拉取失败 ${feed.title}:${message}`);
      return { status: 'error', freshCount: 0 };
    }
  }

  /** 新订阅的首次拉取:历史按 baseline 静默,失败也保留订阅。 */
  async adoptFeed(feed: FeedRecord, baselineNotify: number, baselineAsRead: boolean): Promise<PollResult> {
    return this.pollFeed(feed, {
      silentError: true,
      baseline: Math.max(0, Math.min(5, Math.floor(baselineNotify))),
      baselineAsRead,
    });
  }

  private errorHint(kind: string, status: number | undefined): string {
    if (kind === 'http' && status === 404) return '源可能已迁移,检查地址或退订';
    if (kind === 'http' && (status === 401 || status === 403)) return '站点可能拒绝程序访问,试试在面板里给这个源换浏览器 UA';
    if (kind === 'http' && (status === 429 || status === 503)) return '请求太频繁或站点过载,已自动退避';
    if (kind === 'timeout') return '站点响应太慢';
    if (kind === 'size') return '响应体超过 2MB 上限';
    if (kind === 'parse') return '响应不是有效的 RSS/Atom';
    return '网络错误';
  }

  private nextPollTime(feed: FeedRecord): string {
    const base = this.intervalOf(feed) * 60_000;
    const jitter = base * 0.2;
    const wait = base + (Math.random() * 2 - 1) * jitter;
    return new Date(this.now().getTime() + Math.max(60_000, wait)).toISOString();
  }

  /** 新条目进入合批缓冲;策略过滤在这里(mute 源不播报)。 */
  private enqueueEligible(feed: FeedRecord, item: ItemRecord, now: Date): void {
    if (feed.notify !== 'notify') return;
    this.buffer.push({
      feedId: feed.id,
      feedTitle: feed.title,
      item,
      score: scoreItem(feed, item, now),
      enqueuedAt: now.getTime(),
    });
    if (this.buffer.length >= Math.max(1, this.deps.cfg.eventMaxHeadlines)) this.flushBatch();
  }

  private flushBatchIfDue(): void {
    if (this.buffer.length === 0) return;
    const windowMs = Math.max(5, this.deps.cfg.eventBatchSeconds) * 1000;
    const oldest = Math.min(...this.buffer.map((entry) => entry.enqueuedAt));
    if (this.now().getTime() - oldest >= windowMs) this.flushBatch();
  }

  /** 组一条事件:按分排序 → 截 maxHeadlines → 机械压缩;装不下的留在缓冲,下批再来。 */
  flushBatch(): void {
    if (this.buffer.length === 0) return;
    const cfg = this.deps.cfg;
    const maxHeadlines = Math.max(1, Math.floor(cfg.eventMaxHeadlines));
    const maxChars = Math.max(400, Math.floor(cfg.eventMaxChars));
    const ordered = [...this.buffer].sort((a, b) =>
      (b.score - a.score)
      || b.item.publishedAt.localeCompare(a.item.publishedAt));
    const shown: BufferedEntry[] = [];
    const lines: string[] = [];
    let used = 0;
    for (const entry of ordered.slice(0, maxHeadlines)) {
      const title = entry.item.title.slice(0, 80) || '(无标题)';
      const summary = entry.item.plain.replace(/\s+/g, ' ').slice(0, 100);
      const line = `[${entry.feedTitle}] ${title}${summary ? ` — ${summary}` : ''}`;
      if (used + line.length > maxChars && shown.length > 0) break;
      lines.push(line);
      used += line.length;
      shown.push(entry);
    }
    if (shown.length === 0) return;
    const dropped = ordered.length - shown.length;
    const shownKeys = shown.map((entry) => entry.item.key);
    const shownKeySet = new Set(shownKeys);
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (shownKeySet.has(this.buffer[i].item.key)) this.buffer.splice(i, 1);
    }
    const text = `RSS ${shown.length} 条新内容${dropped > 0 ? `(另有 ${dropped} 条未展开)` : ''}:\n`
      + lines.map((line, i) => `${CIRCLED[i] ?? '·'} ${line}`).join('\n');
    this.deps.onBatch?.({
      text,
      meta: {
        feedIds: [...new Set(shown.map((entry) => entry.feedId))],
        itemKeys: shownKeys,
        total: ordered.length,
        dropped,
      },
    });
  }

  private maybeFireDigest(): void {
    const due = this.digestDueAt();
    if (due == null) return;
    const now = this.now().getTime();
    if (due - now > 60_000) return;
    // 同一分钟只触发一次;重启后最多重复一次晨报,可接受。
    if (now - this.lastDigestFiredAt < 60_000) return;
    this.lastDigestFiredAt = now;
    this.deps.onDigestDue?.();
  }

  /** 立即拉取(工具/面板触发),绕过排程;错误事件不推(回执里自己说)。 */
  async refresh(feedIds?: readonly string[]): Promise<RefreshOutcome[]> {
    const wanted = feedIds && feedIds.length > 0 ? new Set(feedIds) : null;
    const targets = this.deps.store.feeds().filter((feed) => !feed.paused && (!wanted || wanted.has(feed.id)));
    const concurrency = Math.max(1, Math.min(8, Math.floor(this.deps.cfg.pollConcurrency)));
    const outcomes: RefreshOutcome[] = [];
    let index = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, targets.length)) }, async () => {
      while (index < targets.length) {
        const feed = targets[index];
        index += 1;
        const result = await this.pollFeed(feed, { silentError: true });
        const state = this.deps.store.feed(feed.id);
        outcomes.push({
          feedId: feed.id,
          feedTitle: feed.title,
          ok: result.status !== 'error',
          newCount: result.freshCount,
          notModified: result.status === 'not-modified',
          error: state?.lastError ?? null,
        });
      }
    });
    await Promise.all(workers);
    // 手动拉取 = 明确的"现在就要看":立即合批推送,不等 20s 窗口(定时轮询仍走窗口)。
    this.flushBatch();
    this.deps.store.flushNow();
    return outcomes;
  }
}
