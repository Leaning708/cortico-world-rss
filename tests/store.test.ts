import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RssStore } from '../src/store.ts';

function makeStore(): { store: RssStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rss-store-'));
  return { store: new RssStore(dir), dir };
}

function parsedItem(uid: string, title = uid, description = `${uid} 的摘要`) {
  return {
    uid, title, description, contentHtml: null,
    url: `https://example.org/${uid}`, author: null,
    publishedAt: '2026-11-06T08:00:00.000Z', enclosure: null,
  };
}

describe('RssStore', () => {
  it('增删改源,URL 归一化匹配', () => {
    const { store } = makeStore();
    const feed = store.createFeed({ url: 'https://a.com/feed/', title: 'A' });
    expect(store.feed(feed.id)?.title).toBe('A');
    expect(store.feedByUrl('https://a.com/feed')?.id).toBe(feed.id);
    store.updateFeed(feed.id, { title: '改名', paused: true, intervalMinutes: 15 });
    const updated = store.feed(feed.id);
    expect(updated?.title).toBe('改名');
    expect(updated?.paused).toBe(true);
    expect(updated?.intervalMinutes).toBe(15);
    const removed = store.removeFeed(feed.id, false);
    expect(removed.feed.title).toBe('改名');
    expect(store.feeds()).toHaveLength(0);
  });

  it('条目入库去重:key 与 seenKeys 双保险', () => {
    const { store } = makeStore();
    const feed = store.createFeed({ url: 'https://a.com/feed', title: 'A' });
    const first = store.addItems(feed, [parsedItem('uid-1'), parsedItem('uid-2')], new Date('2026-11-06T09:00:00Z'));
    expect(first.fresh).toHaveLength(2);
    expect(first.duplicates).toBe(0);
    const second = store.addItems(feed, [parsedItem('uid-1'), parsedItem('uid-3')], new Date('2026-11-06T09:05:00Z'));
    expect(second.fresh.map((i) => i.uid)).toEqual(['uid-3']);
    expect(second.duplicates).toBe(1);
    // seenKeys 覆盖(条目被清理后依然防重推)。
    store.setPollState(feed.id, { seenKeys: ['uid-1', 'uid-2', 'uid-3'] });
    const third = store.addItems(feed, [parsedItem('uid-1')], new Date('2026-11-06T09:10:00Z'));
    expect(third.fresh).toHaveLength(0);
  });

  it('baseline:历史静默且已读,最新 N 条保持未通知未读', () => {
    const { store } = makeStore();
    const feed = store.createFeed({ url: 'https://a.com/feed', title: 'A' });
    const { fresh } = store.addItems(
      feed,
      [parsedItem('old-1'), parsedItem('old-2'), parsedItem('new-1')],
      new Date(),
      { baselineMarkSeen: true, baselineNotifyCount: 1 },
    );
    expect(fresh).toHaveLength(3);
    // publishedAt 全相同时排序取最后一条作为"最新"。
    const silent = fresh.filter((item) => item.notified);
    const live = fresh.filter((item) => !item.notified);
    expect(silent).toHaveLength(2);
    expect(live).toHaveLength(1);
    // 基线历史不污染未读:静默的条目同时标已读。
    expect(silent.every((item) => item.read)).toBe(true);
    expect(live.every((item) => !item.read)).toBe(true);
  });

  it('未来超过 24h 的发布时间钳回抓取时间', () => {
    const { store } = makeStore();
    const feed = store.createFeed({ url: 'https://a.com/feed', title: 'A' });
    const fetchedAt = new Date('2026-11-06T09:00:00Z');
    const { fresh } = store.addItems(feed, [{
      ...parsedItem('future'),
      publishedAt: '2027-01-01T00:00:00.000Z',
    }], fetchedAt);
    expect(fresh[0].publishedAt).toBe('2026-11-06T09:00:00.000Z');
  });

  it('查询:scope/read/starred/query/limit', () => {
    const { store } = makeStore();
    const feed = store.createFeed({ url: 'https://a.com/feed', title: 'A' });
    store.addItems(feed, [parsedItem('i1', '关键词标题一'), parsedItem('i2', '普通标题'), parsedItem('i3', '关键词标题三')], new Date());
    // 用真实 key 标已读。
    store.markItems({ keys: [`${feed.id}:i1`], status: 'read' });
    expect(store.unreadCount()).toBe(2);
    const byQuery = store.itemsQuery({ query: '关键词' });
    expect(byQuery.total).toBe(1); // i1 已读,不在默认 unread 范围
    const all = store.itemsQuery({ scope: 'all' });
    expect(all.total).toBe(3);
    store.markItems({ keys: [`${feed.id}:i3`], status: 'starred' });
    expect(store.itemsQuery({ scope: 'starred' }).items.map((i) => i.uid)).toEqual(['i3']);
  });

  it('compact:保留期、每源上限、总量上限,starred 豁免', () => {
    const { store } = makeStore();
    const feed = store.createFeed({ url: 'https://a.com/feed', title: 'A' });
    const old = new Date('2026-10-01T00:00:00Z');
    store.addItems(feed, [parsedItem('old'), parsedItem('old-star')], old);
    store.addItems(feed, [parsedItem('fresh')], new Date('2026-11-06T09:00:00Z'));
    store.markItems({ keys: [`${feed.id}:old-star`], status: 'starred' });
    store.compact(new Date('2026-11-07T00:00:00Z'));
    const uids = () => store.itemsQuery({ feedId: feed.id, scope: 'all', limit: 100 }).items.map((i) => i.uid);
    expect(uids()).toContain('old-star');
    expect(uids()).toContain('fresh');
    expect(uids()).not.toContain('old');
  });

  it('flushNow 原子写盘,重载后数据一致;损坏文件按空表处理', () => {
    const { store, dir } = makeStore();
    const feed = store.createFeed({ url: 'https://a.com/feed', title: 'A' });
    store.addItems(feed, [parsedItem('persist')], new Date());
    store.flushNow();
    expect(existsSync(join(dir, 'rss-feeds.json'))).toBe(true);
    const reloaded = new RssStore(dir);
    expect(reloaded.feeds()).toHaveLength(1);
    expect(reloaded.itemsQuery({ scope: 'all' }).total).toBe(1);

    const broken = mkdtempSync(join(tmpdir(), 'rss-broken-'));
    writeFileSync(join(broken, 'rss-items.json'), '{broken json', 'utf8');
    const tolerant = new RssStore(broken);
    expect(tolerant.itemsQuery({ scope: 'all' }).total).toBe(0);
    // 内容会被下次 flushNow 覆盖为合法 JSON。
    tolerant.createFeed({ url: 'https://b.com/feed', title: 'B' });
    tolerant.flushNow();
    expect(() => JSON.parse(readFileSync(join(broken, 'rss-feeds.json'), 'utf8'))).not.toThrow();
  });

  it('旧版本 feeds 文件缺 fullText 时迁移补默认值,并清掉已移除字段', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rss-migrate-'));
    writeFileSync(join(dir, 'rss-feeds.json'), JSON.stringify({
      version: 1,
      feeds: [{
        id: 'f_old', url: 'https://old.org/feed', title: '旧源', notify: 'notify',
        intervalMinutes: 0, include: [], exclude: [], allowPrivate: true, paused: false, weight: 1,
        userAgent: '', createdAt: '2026-10-01T00:00:00Z',
        etag: null, lastModified: null, lastFetchAt: null, lastOkAt: null, lastError: null,
        consecutiveErrors: 0, nextPollAt: null, backoffIndex: 0, seenKeys: [],
      }, {
        id: 'f_digest', url: 'https://digest.org/feed', title: '旧晨报源', notify: 'digest',
        intervalMinutes: 0, paused: false, weight: 1, userAgent: '', fullText: true,
        createdAt: '2026-10-01T00:00:00Z', etag: null, lastModified: null, lastFetchAt: null,
        lastOkAt: null, lastError: null, consecutiveErrors: 0, nextPollAt: null, backoffIndex: 0, seenKeys: [],
      }],
    }), 'utf8');
    const store = new RssStore(dir);
    const feed = store.feeds()[0];
    expect((feed as unknown as Record<string, unknown>).allowPrivate).toBeUndefined();
    expect(feed?.fullText).toBe(true);
    // 已移除的每源关键词字段在加载时清掉。
    expect((feed as unknown as Record<string, unknown>).include).toBeUndefined();
    expect((feed as unknown as Record<string, unknown>).exclude).toBeUndefined();
    // 0.1.38:旧 digest 策略迁移为静默,并落盘。
    expect(store.feeds()[1]?.notify).toBe('mute');
    store.flushNow();
    const persisted = JSON.parse(readFileSync(join(dir, 'rss-feeds.json'), 'utf8')) as { feeds: Array<{ notify: string }> };
    expect(persisted.feeds[1]?.notify).toBe('mute');
  });

  it('createFeed/updateFeed 支持 fullText 按源开关', () => {
    const { store } = makeStore();
    const feed = store.createFeed({ url: 'https://a.com/feed', title: 'A', fullText: false });
    expect(feed.fullText).toBe(false);
    store.updateFeed(feed.id, { fullText: true });
    expect(store.feed(feed.id)?.fullText).toBe(true);
    // 默认:new 源 fullText 开。
    const plain = store.createFeed({ url: 'https://b.com/feed', title: 'B' });
    expect(plain.fullText).toBe(true);
  });

  it('clearItems:按范围与源清空,星标豁免', () => {
    const { store } = makeStore();
    const feedA = store.createFeed({ url: 'https://a.com/feed', title: 'A' });
    store.addItems(feedA, [parsedItem('a1'), parsedItem('a2'), parsedItem('a3')], new Date());
    store.markItems({ keys: [`${feedA.id}:a1`], status: 'read' });
    store.markItems({ keys: [`${feedA.id}:a2`], status: 'starred' });
    // 只清未读:a1 已读、a2 星标保留,a3 清掉。
    expect(store.clearItems({ scope: 'unread', feedId: feedA.id })).toBe(1);
    expect(store.item(`${feedA.id}:a3`)).toBeUndefined();
    expect(store.item(`${feedA.id}:a1`)).not.toBeUndefined();
    expect(store.item(`${feedA.id}:a2`)).not.toBeUndefined();
    // 全清(星标也清,明确范围)。
    expect(store.clearItems({ scope: 'starred' })).toBe(1);
    expect(store.itemsQuery({ scope: 'all' }).total).toBe(1);
  });

  it('deleteItems:按键删除,星标也一并删除', () => {
    const { store } = makeStore();
    const feedA = store.createFeed({ url: 'https://a.com/feed', title: 'A' });
    store.addItems(feedA, [parsedItem('d1'), parsedItem('d2'), parsedItem('d3')], new Date());
    store.markItems({ keys: [`${feedA.id}:d2`], status: 'starred' });
    expect(store.deleteItems([`${feedA.id}:d1`, `${feedA.id}:d2`])).toBe(2);
    expect(store.itemsQuery({ scope: 'all' }).items.map((i) => i.uid)).toEqual(['d3']);
  });

  it('孤儿条目:源已退订后,其条目在 compact 时移除', () => {
    const { store } = makeStore();
    const feedA = store.createFeed({ url: 'https://a.com/feed', title: 'A' });
    store.addItems(feedA, [parsedItem('a1')], new Date('2026-11-07T00:00:00Z'));
    // 模拟旧版本退订不清理:直接从源表移除,条目成为孤儿。
    store.removeFeed(feedA.id, false);
    expect(store.itemsQuery({ scope: 'all' }).total).toBe(1);
    store.compact(new Date());
    expect(store.itemsQuery({ scope: 'all' }).total).toBe(0);
  });

  it('seenKeys 封顶 500', () => {
    const { store } = makeStore();
    const feed = store.createFeed({ url: 'https://a.com/feed', title: 'A' });
    const many = Array.from({ length: 510 }, (_, i) => parsedItem(`uid-${i}`));
    store.addItems(feed, many, new Date());
    expect(feed.seenKeys.length).toBeLessThanOrEqual(500);
  });
});

describe('全文缓存', () => {
  it('写入、截断、按时间淘汰最旧,并可持久化', () => {
    const { store, dir } = makeStore();
    const feed = store.createFeed({ url: 'https://a.com/feed', title: 'A' });
    const items = Array.from({ length: 205 }, (_, i) => parsedItem(`cache-${i}`));
    store.addItems(feed, items, new Date('2026-11-06T09:00:00Z'));
    const keys = store.itemsQuery({ scope: 'all', limit: 1000 }).items.map((item) => item.key);
    expect(keys).toHaveLength(205);
    for (const [index, key] of keys.entries()) {
      store.setItemFullText(key, `正文${index}`, new Date(Date.UTC(2026, 10, 6, 9, 0, index)));
    }
    const cached = store.itemsQuery({ scope: 'all', limit: 1000 }).items.filter((item) => item.fullText);
    expect(cached).toHaveLength(200);
    // 205 条只保留最近 200 条,最早的 5 条被淘汰。
    expect(store.item(keys[4])?.fullText).toBeUndefined();
    expect(store.item(keys[5])?.fullText).toBeDefined();
    // 单条上限。
    store.setItemFullText(keys[5], 'x'.repeat(20_000), new Date());
    expect(store.item(keys[5])?.fullText).toHaveLength(12_000);
    store.flushNow();
    const reloaded = new RssStore(dir);
    expect(reloaded.item(keys[5])?.fullText).toHaveLength(12_000);
  });
});
