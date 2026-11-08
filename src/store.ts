/**
 * 订阅源表 + 条目库:dataDir 下两份 JSON,原子写(tmp + rename),显式 flushNow。
 * 预算:总量/每源条数/每源已见 guid 记忆都有硬上限;starred 豁免清理。
 * 变更先记内存,调用方在自然边界(轮询一轮结束、一次工具调用结束)flushNow;
 * 崩溃最多丢最后一次 flush 之后的变化,重启后表现为重复推送候选,可接受。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ParsedItem } from './parse.ts';

export type NotifyMode = 'notify' | 'digest' | 'mute';

export interface FeedRecord {
  id: string;
  url: string;
  title: string;
  notify: NotifyMode;
  /** 0 = 用全局默认。 */
  intervalMinutes: number;
  /** 命中任一才推送(空 = 不过滤)。 */
  include: string[];
  /** 命中任一不推送。 */
  exclude: string[];
  paused: boolean;
  /** 排序权重 1..5,仅影响事件内顺序。 */
  weight: number;
  /** 单源 UA 覆盖;空 = 用全局。 */
  userAgent: string;
  /** 本源允许私网地址(自建 RSSHub 等);默认关,详情弹框里按源打开。 */
  allowPrivate: boolean;
  /** 本源允许 rss_read(full) 抓原文页;默认开。 */
  fullText: boolean;
  createdAt: string;
  // —— 轮询状态(扩展维护,面板只读) ——
  etag: string | null;
  lastModified: string | null;
  lastFetchAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  /** ISO 时刻;null = 未排程。 */
  nextPollAt: string | null;
  backoffIndex: number;
  /** 最近 N 个已见 uid,防"换 guid 重发"与清理后的重复推送。 */
  seenKeys: string[];
}

export interface ItemRecord {
  key: string;
  feedId: string;
  uid: string;
  title: string;
  plain: string;
  url: string;
  author: string | null;
  publishedAt: string;
  fetchedAt: string;
  enclosure: { mime: string; url: string } | null;
  /** 已进过推送事件。 */
  notified: boolean;
  read: boolean;
  starred: boolean;
}

export interface StoreLimits {
  retentionDays: number;
  maxItemsTotal: number;
  maxItemsPerFeed: number;
  seenKeysPerFeed: number;
  maxPlainChars: number;
}

export const DEFAULT_LIMITS: StoreLimits = {
  retentionDays: 30,
  maxItemsTotal: 2_000,
  maxItemsPerFeed: 200,
  seenKeysPerFeed: 500,
  maxPlainChars: 2_000,
};

const FEEDS_FILE = 'rss-feeds.json';
const ITEMS_FILE = 'rss-items.json';

interface FeedsFile { version: 1; feeds: FeedRecord[] }
interface ItemsFile { version: 1; items: ItemRecord[] }

export function newFeedId(): string {
  return `f_${randomBytes(4).toString('hex')}`;
}

/** 未来超过 24h 的发布时间视为源时钟错误,钳回抓取时间。 */
function clampPublishedAt(iso: string | null, fetchedAt: Date): string {
  if (!iso) return fetchedAt.toISOString();
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return fetchedAt.toISOString();
  if (ts - fetchedAt.getTime() > 24 * 3600 * 1000) return fetchedAt.toISOString();
  return new Date(ts).toISOString();
}

function asKeywordList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 20);
}

export class RssStore {
  private feedsData: FeedsFile;
  private itemsData: ItemsFile;
  private dirty = false;
  private readonly feedsPath: string;
  private readonly itemsPath: string;

  constructor(
    dataDir: string,
    private readonly limits: StoreLimits = DEFAULT_LIMITS,
    private readonly log: { warn(message: string): void } = { warn: () => {} },
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.feedsPath = join(dataDir, FEEDS_FILE);
    this.itemsPath = join(dataDir, ITEMS_FILE);
    this.feedsData = this.loadFile<FeedsFile>(this.feedsPath, { version: 1, feeds: [] });
    this.itemsData = this.loadFile<ItemsFile>(this.itemsPath, { version: 1, items: [] });
    this.migrateFeeds();
    this.compact(new Date());
  }

  /** 旧版本文件缺 allowPrivate/fullText 字段时补默认值(私有:加载即迁移)。 */
  private migrateFeeds(): void {
    for (const feed of this.feedsData.feeds) {
      if (typeof feed.allowPrivate !== 'boolean') feed.allowPrivate = false;
      if (typeof feed.fullText !== 'boolean') feed.fullText = true;
    }
  }

  private loadFile<T>(path: string, fallback: T): T {
    if (!existsSync(path)) return fallback;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as T;
      if (!parsed || typeof parsed !== 'object') return fallback;
      return parsed;
    } catch (error) {
      this.log.warn(`存储文件损坏,按空表处理:${path}(${error instanceof Error ? error.message : String(error)})`);
      return fallback;
    }
  }

  private saveAtomic(path: string, value: unknown): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), 'utf8');
    renameSync(tmp, path);
  }

  /** 调用方在自然边界调用;有脏数据才写。 */
  flushNow(): void {
    if (!this.dirty) return;
    this.saveAtomic(this.feedsPath, this.feedsData);
    this.saveAtomic(this.itemsPath, this.itemsData);
    this.dirty = false;
  }

  // ── 源表 ────────────────────────────────────────────────────────────

  feeds(): FeedRecord[] {
    return this.feedsData.feeds;
  }

  feed(id: string): FeedRecord | undefined {
    return this.feedsData.feeds.find((f) => f.id === id);
  }

  feedByUrl(url: string): FeedRecord | undefined {
    const normalized = url.trim().replace(/\/+$/, '');
    return this.feedsData.feeds.find((f) => f.url.replace(/\/+$/, '') === normalized);
  }

  createFeed(input: {
    url: string;
    title: string;
    notify?: NotifyMode;
    intervalMinutes?: number;
    include?: string[];
    exclude?: string[];
    weight?: number;
    userAgent?: string;
    allowPrivate?: boolean;
    fullText?: boolean;
  }): FeedRecord {
    const feed: FeedRecord = {
      id: newFeedId(),
      url: input.url.trim(),
      title: input.title.trim() || input.url,
      notify: input.notify ?? 'notify',
      intervalMinutes: Math.max(0, Math.floor(input.intervalMinutes ?? 0)),
      include: asKeywordList(input.include),
      exclude: asKeywordList(input.exclude),
      paused: false,
      weight: Math.min(5, Math.max(1, Math.floor(input.weight ?? 1))),
      userAgent: (input.userAgent ?? '').trim(),
      allowPrivate: input.allowPrivate === true,
      fullText: input.fullText !== false,
      createdAt: new Date().toISOString(),
      etag: null,
      lastModified: null,
      lastFetchAt: null,
      lastOkAt: null,
      lastError: null,
      consecutiveErrors: 0,
      nextPollAt: null,
      backoffIndex: 0,
      seenKeys: [],
    };
    this.feedsData.feeds.push(feed);
    this.dirty = true;
    return feed;
  }

  /** 白名单字段更新;返回更新后的记录。 */
  updateFeed(id: string, patch: Partial<Pick<FeedRecord,
    'title' | 'notify' | 'intervalMinutes' | 'include' | 'exclude' | 'paused' | 'weight' | 'userAgent' | 'allowPrivate' | 'fullText'
  >>): FeedRecord | undefined {
    const feed = this.feed(id);
    if (!feed) return undefined;
    if (patch.title != null) feed.title = patch.title.trim() || feed.title;
    if (patch.notify != null) feed.notify = patch.notify;
    if (patch.intervalMinutes != null) feed.intervalMinutes = Math.max(0, Math.floor(patch.intervalMinutes));
    if (patch.include != null) feed.include = asKeywordList(patch.include);
    if (patch.exclude != null) feed.exclude = asKeywordList(patch.exclude);
    if (patch.paused != null) {
      feed.paused = patch.paused;
      // 恢复时立刻排一次,暂停时清掉排程。
      feed.nextPollAt = patch.paused ? null : new Date().toISOString();
    }
    if (patch.weight != null) feed.weight = Math.min(5, Math.max(1, Math.floor(patch.weight)));
    if (patch.userAgent != null) feed.userAgent = patch.userAgent.trim();
    if (patch.allowPrivate != null) feed.allowPrivate = patch.allowPrivate === true;
    if (patch.fullText != null) feed.fullText = patch.fullText !== false;
    this.dirty = true;
    return feed;
  }

  removeFeed(id: string, purgeItems: boolean): { feed: FeedRecord; itemsPurged: number } {
    const index = this.feedsData.feeds.findIndex((f) => f.id === id);
    if (index < 0) throw new Error(`unknown feed: ${id}`);
    const [feed] = this.feedsData.feeds.splice(index, 1);
    let itemsPurged = 0;
    if (purgeItems) {
      const before = this.itemsData.items.length;
      this.itemsData.items = this.itemsData.items.filter((item) => item.feedId !== id);
      itemsPurged = before - this.itemsData.items.length;
    }
    this.dirty = true;
    return { feed, itemsPurged };
  }

  /** 轮询状态的局部更新;全部字段由扩展内部维护。 */
  setPollState(id: string, patch: Partial<Pick<FeedRecord,
    'etag' | 'lastModified' | 'lastFetchAt' | 'lastOkAt' | 'lastError' | 'consecutiveErrors' | 'nextPollAt' | 'backoffIndex' | 'seenKeys'
  >>): void {
    const feed = this.feed(id);
    if (!feed) return;
    Object.assign(feed, patch);
    this.dirty = true;
  }

  hasSeenKey(feedId: string, uid: string): boolean {
    const feed = this.feed(feedId);
    return feed ? feed.seenKeys.includes(uid) : false;
  }

  // ── 条目 ────────────────────────────────────────────────────────────

  /**
   * 入库一批解析结果。去重:与库内 key、每源 seenKeys 都比对。
   * 返回的新条目 notified=false;重复条目只刷新 seenKeys。
   */
  addItems(
    feed: FeedRecord,
    parsed: ParsedItem[],
    fetchedAt: Date,
    opts: { baselineMarkSeen?: boolean; baselineNotifyCount?: number; baselineAsRead?: boolean } = {},
  ): { fresh: ItemRecord[]; duplicates: number } {
    const fresh: ItemRecord[] = [];
    let duplicates = 0;
    const existing = new Set(this.itemsData.items.filter((i) => i.feedId === feed.id).map((i) => i.key));
    for (const source of parsed) {
      const key = `${feed.id}:${source.uid}`;
      if (existing.has(key) || feed.seenKeys.includes(source.uid)) {
        duplicates += 1;
        continue;
      }
      const record: ItemRecord = {
        key,
        feedId: feed.id,
        uid: source.uid,
        title: source.title,
        plain: source.description.slice(0, this.limits.maxPlainChars),
        url: source.url,
        author: source.author,
        publishedAt: clampPublishedAt(source.publishedAt, fetchedAt),
        fetchedAt: fetchedAt.toISOString(),
        enclosure: source.enclosure,
        notified: false,
        read: false,
        starred: false,
      };
      this.itemsData.items.push(record);
      existing.add(key);
      feed.seenKeys.push(source.uid);
      fresh.push(record);
    }
    if (feed.seenKeys.length > this.limits.seenKeysPerFeed) {
      feed.seenKeys = feed.seenKeys.slice(-this.limits.seenKeysPerFeed);
    }
    // 基线:新订阅的历史全部视为已见(不推送);默认同时标已读(不污染未读,行业默认),
    // 关闭 baselineAsRead 时保持旧行为(计入未读)。可选把最新 N 条留作"新消息"。
    // 排序:发布时间倒序;相同时间时按源里出现顺序,靠后的更新。
    if (opts.baselineMarkSeen && fresh.length > 0) {
      const keepFresh = opts.baselineNotifyCount ?? 0;
      const asRead = opts.baselineAsRead !== false;
      const ordered = [...fresh.entries()].sort((a, b) =>
        b[1].publishedAt.localeCompare(a[1].publishedAt) || b[0] - a[0]);
      const silent = new Set(ordered.slice(keepFresh).map(([, record]) => record.key));
      for (const record of fresh) {
        if (silent.has(record.key)) {
          record.notified = true;
          record.read = asRead;
        }
      }
    }
    this.dirty = true;
    return { fresh, duplicates };
  }

  itemsQuery(opts: {
    feedId?: string;
    scope?: 'unread' | 'all' | 'starred';
    query?: string;
    limit?: number;
    offset?: number;
  }): { total: number; items: ItemRecord[] } {
    const scope = opts.scope ?? 'unread';
    const query = opts.query?.trim().toLowerCase() ?? '';
    const matched = this.itemsData.items.filter((item) => {
      if (opts.feedId && item.feedId !== opts.feedId) return false;
      if (scope === 'unread' && item.read) return false;
      if (scope === 'starred' && !item.starred) return false;
      if (query && !`${item.title}\n${item.plain}`.toLowerCase().includes(query)) return false;
      return true;
    });
    matched.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.max(1, opts.limit ?? 20);
    return { total: matched.length, items: matched.slice(offset, offset + limit) };
  }

  item(key: string): ItemRecord | undefined {
    return this.itemsData.items.find((i) => i.key === key);
  }

  unreadCount(feedId?: string): number {
    return this.itemsData.items.filter((i) => !i.read && (!feedId || i.feedId === feedId)).length;
  }

  /** 清空条目:按范围(unread/all/starred)与可选的源;'all'/'unread' 时星标豁免,starred 范围只清星标条目。返回删除数。 */
  clearItems(opts: { feedId?: string; scope: 'unread' | 'all' | 'starred' }): number {
    const before = this.itemsData.items.length;
    this.itemsData.items = this.itemsData.items.filter((i) => {
      if (opts.feedId && i.feedId !== opts.feedId) return true; // 其他源保留
      if (opts.scope === 'starred') return !i.starred;          // 星标范围:只清星标条目
      if (i.starred) return true;                               // 其余范围星标豁免
      if (opts.scope === 'unread') return i.read;               // 只清未读,已读保留
      return false;                                             // all:全清(星标已豁免)
    });
    const removed = before - this.itemsData.items.length;
    if (removed > 0) this.dirty = true;
    return removed;
  }

  /** 按键删除条目(用户勾选,明确意图):已读/星标一并删除。返回删除数。 */
  deleteItems(keys: readonly string[]): number {
    const keySet = new Set(keys);
    const before = this.itemsData.items.length;
    this.itemsData.items = this.itemsData.items.filter((i) => !keySet.has(i.key));
    const removed = before - this.itemsData.items.length;
    if (removed > 0) this.dirty = true;
    return removed;
  }

  /** 标记已读/未读/星标;keys 给了就只用 keys,否则按 feedId 或全部(非 starred 的 read 操作仍按记录逐条)。 */
  markItems(opts: {
    keys?: string[];
    feedId?: string;
    all?: boolean;
    status: 'read' | 'unread' | 'starred' | 'unstarred';
  }): number {
    const keySet = opts.keys ? new Set(opts.keys) : null;
    let changed = 0;
    for (const item of this.itemsData.items) {
      const selected = keySet
        ? keySet.has(item.key)
        : opts.all || (opts.feedId ? item.feedId === opts.feedId : false);
      if (!selected) continue;
      if (opts.status === 'read') { if (!item.read) { item.read = true; changed++; } }
      else if (opts.status === 'unread') { if (item.read) { item.read = false; changed++; } }
      else if (opts.status === 'starred') { if (!item.starred) { item.starred = true; changed++; } }
      else if (opts.status === 'unstarred') { if (item.starred) { item.starred = false; changed++; } }
    }
    if (changed) this.dirty = true;
    return changed;
  }

  markNotified(keys: readonly string[]): void {
    const keySet = new Set(keys);
    for (const item of this.itemsData.items) {
      if (keySet.has(item.key) && !item.notified) {
        item.notified = true;
        this.dirty = true;
      }
    }
  }

  /** 近 ms 毫秒内入库的条数(晨报统计)。 */
  countSince(ms: number, now: Date): number {
    const threshold = now.getTime() - ms;
    return this.itemsData.items.filter((item) => new Date(item.fetchedAt).getTime() >= threshold).length;
  }

  /** 保留期与容量清理;starred 豁免。加载时与每轮轮询后调用。 */
  compact(now: Date): void {
    const cutoff = now.getTime() - this.limits.retentionDays * 24 * 3600 * 1000;
    const knownFeeds = new Set(this.feedsData.feeds.map((f) => f.id));
    const kept: ItemRecord[] = [];
    const perFeed = new Map<string, number>();
    for (const item of this.itemsData.items) {
      // 孤儿条目:源已退订(旧版本退订不清理的遗留),一并移除。
      if (!knownFeeds.has(item.feedId)) continue;
      const isOld = new Date(item.fetchedAt).getTime() < cutoff;
      if (isOld && !item.starred) continue;
      kept.push(item);
      perFeed.set(item.feedId, (perFeed.get(item.feedId) ?? 0) + 1);
    }
    // 每源上限:超出的从最旧开始丢(非 starred)。
    for (const [feedId, count] of perFeed) {
      if (count <= this.limits.maxItemsPerFeed) continue;
      const feedItems = kept
        .filter((i) => i.feedId === feedId && !i.starred)
        .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
      const drop = new Set(feedItems.slice(0, count - this.limits.maxItemsPerFeed).map((i) => i.key));
      for (const key of drop) {
        const index = kept.findIndex((i) => i.key === key);
        if (index >= 0) kept.splice(index, 1);
      }
    }
    // 总量上限:全库最旧的先丢(非 starred)。
    if (kept.length > this.limits.maxItemsTotal) {
      const droppable = kept.filter((i) => !i.starred).sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
      const drop = new Set(droppable.slice(0, kept.length - this.limits.maxItemsTotal).map((i) => i.key));
      for (let i = kept.length - 1; i >= 0; i--) {
        if (drop.has(kept[i].key)) kept.splice(i, 1);
      }
    }
    if (kept.length !== this.itemsData.items.length) {
      this.itemsData.items = kept;
      this.dirty = true;
    }
  }
}
