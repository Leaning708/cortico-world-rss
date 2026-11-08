import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { text } from './strings.ts';

/** config.json 的 worlds.rss 段。默认禁用,由 bot 声明或部署配置启用。 */
export interface RssConfigSection {
  enabled: boolean;
  /** 全局默认轮询间隔(分钟);单源可用 intervalMinutes 覆盖。每次调度现读。 */
  pollIntervalMinutes: number;
  /** 同时拉取的源数量上限;参与调度器构造,重建 World 生效。 */
  pollConcurrency: number;
  /** 单次 HTTP 请求超时(毫秒)。每次请求现读。 */
  requestTimeoutMs: number;
  /** 订阅容量上限;每次添加现读。 */
  maxFeeds: number;
  /** 事件合批窗口(秒)。 */
  eventBatchSeconds: number;
  /** 单条事件最多的头条数。 */
  eventMaxHeadlines: number;
  /** 单条事件的字符上限。 */
  eventMaxChars: number;
  /** 每日晨报开关。 */
  digestEnabled: boolean;
  /** 晨报时刻 "09:00"(部署时区)。 */
  digestTime: string;
  /** 应用启动时立即拉取全部源并播报本次新内容。 */
  startupNotify: boolean;
  /** 事件送达后是否顺手标已读。默认关:推送不等于用户看过。 */
  autoMarkReadOnNotify: boolean;
  /** 条目保留天数;compact 每轮现读,改了即时生效。 */
  retentionDays: number;
  /** 全库条目上限;超出从最旧清理(星标豁免)。 */
  maxItemsTotal: number;
  /** 单源条目上限。 */
  maxItemsPerFeed: number;
  /** 新订阅的历史条目标为已读(不污染未读);默认开。 */
  baselineAsRead: boolean;
}

export const RSS_ID = 'rss';

export const NOTIFY_MODES = ['notify', 'mute'] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];

export const RSS_DEFAULTS: RssConfigSection = {
  enabled: false,
  pollIntervalMinutes: 30,
  pollConcurrency: 4,
  requestTimeoutMs: 15_000,
  maxFeeds: 50,
  eventBatchSeconds: 20,
  eventMaxHeadlines: 8,
  eventMaxChars: 1200,
  digestEnabled: false,
  digestTime: '09:00',
  startupNotify: true,
  autoMarkReadOnNotify: false,
  retentionDays: 30,
  maxItemsTotal: 2_000,
  maxItemsPerFeed: 200,
  baselineAsRead: true,
};

/** World 配置的 JSON Schema 声明;每个路径都必须落在 worlds.rss. 段内。 */
export function rssConfigGroup(language: Language): ConfigGroup {
  const t = text(language);
  return {
    id: `world:${RSS_ID}`,
    owner: `world:${RSS_ID}`,
    schema: {
      type: 'object',
      title: t.configTitle,
      description: t.configDescription,
      properties: {
        'worlds.rss.pollIntervalMinutes': {
          type: 'integer',
          title: t.pollIntervalTitle,
          description: t.pollIntervalDescription,
          minimum: 1,
          maximum: 1440,
          'x-hot': true,
        },
        'worlds.rss.pollConcurrency': {
          type: 'integer',
          title: t.pollConcurrencyTitle,
          description: t.pollConcurrencyDescription,
          minimum: 1,
          maximum: 8,
          'x-hot': false,
        },
        'worlds.rss.requestTimeoutMs': {
          type: 'integer',
          title: t.requestTimeoutTitle,
          description: t.requestTimeoutDescription,
          minimum: 3_000,
          maximum: 60_000,
          multipleOf: 500,
          'x-scale': 1000,
          'x-suffix': 's',
          'x-hot': true,
        },
        'worlds.rss.maxFeeds': {
          type: 'integer',
          title: t.maxFeedsTitle,
          description: t.maxFeedsDescription,
          minimum: 1,
          maximum: 500,
          'x-hot': true,
        },
        'worlds.rss.eventBatchSeconds': {
          type: 'integer',
          title: t.eventBatchTitle,
          description: t.eventBatchDescription,
          minimum: 5,
          maximum: 120,
          'x-scale': 1000,
          'x-suffix': 's',
          'x-hot': true,
        },
        'worlds.rss.eventMaxHeadlines': {
          type: 'integer',
          title: t.eventMaxHeadlinesTitle,
          description: t.eventMaxHeadlinesDescription,
          minimum: 1,
          maximum: 20,
          'x-hot': true,
        },
        'worlds.rss.eventMaxChars': {
          type: 'integer',
          title: t.eventMaxCharsTitle,
          description: t.eventMaxCharsDescription,
          minimum: 400,
          maximum: 4_000,
          'x-hot': true,
        },
        'worlds.rss.digestEnabled': {
          type: 'boolean',
          title: t.digestEnabledTitle,
          description: t.digestEnabledDescription,
          'x-hot': true,
        },
        'worlds.rss.digestTime': {
          type: 'string',
          title: t.digestTimeTitle,
          description: t.digestTimeDescription,
          'x-hot': true,
        },
        'worlds.rss.startupNotify': {
          type: 'boolean',
          title: t.startupNotifyTitle,
          description: t.startupNotifyDescription,
          'x-hot': true,
        },
        'worlds.rss.autoMarkReadOnNotify': {
          type: 'boolean',
          title: t.autoMarkTitle,
          description: t.autoMarkDescription,
          'x-hot': true,
        },
        'worlds.rss.retentionDays': {
          type: 'integer',
          title: t.retentionTitle,
          description: t.retentionDescription,
          minimum: 3,
          maximum: 365,
          'x-hot': true,
        },
        'worlds.rss.maxItemsTotal': {
          type: 'integer',
          title: t.maxItemsTotalTitle,
          description: t.maxItemsTotalDescription,
          minimum: 100,
          maximum: 20_000,
          'x-hot': true,
        },
        'worlds.rss.maxItemsPerFeed': {
          type: 'integer',
          title: t.maxItemsPerFeedTitle,
          description: t.maxItemsPerFeedDescription,
          minimum: 20,
          maximum: 5_000,
          'x-hot': true,
        },
        'worlds.rss.baselineAsRead': {
          type: 'boolean',
          title: t.baselineAsReadTitle,
          description: t.baselineAsReadDescription,
          'x-hot': true,
        },
      },
    },
  };
}

/** 配置分组:按「轮询与网络 / 通知策略 / 阅读与数据」三张卡呈现,降低单页旋钮密度。 */
export function rssConfigGroups(language: Language): ConfigGroup[] {
  const t = text(language);
  const full = rssConfigGroup(language);
  const pick = (keys: readonly string[], id: string, title: string, description: string): ConfigGroup => {
    const properties: typeof full.schema.properties = {};
    for (const key of keys) {
      const property = full.schema.properties[key];
      if (property) properties[key] = property;
    }
    return {
      id,
      owner: `world:${RSS_ID}`,
      schema: { type: 'object', title, description, properties },
    };
  };
  return [
    pick(
      [
        'worlds.rss.pollIntervalMinutes',
        'worlds.rss.pollConcurrency',
        'worlds.rss.requestTimeoutMs',
        'worlds.rss.maxFeeds',
      ],
      `world:${RSS_ID}.polling`,
      t.groupPollingTitle,
      t.groupPollingDescription,
    ),
    pick(
      [
        'worlds.rss.eventBatchSeconds',
        'worlds.rss.eventMaxHeadlines',
        'worlds.rss.eventMaxChars',
        'worlds.rss.digestEnabled',
        'worlds.rss.digestTime',
        'worlds.rss.startupNotify',
        'worlds.rss.autoMarkReadOnNotify',
      ],
      `world:${RSS_ID}.notify`,
      t.groupNotifyTitle,
      t.groupNotifyDescription,
    ),
    pick(
      ['worlds.rss.retentionDays', 'worlds.rss.maxItemsTotal', 'worlds.rss.maxItemsPerFeed', 'worlds.rss.baselineAsRead'],
      `world:${RSS_ID}.data`,
      t.groupDataTitle,
      t.groupDataDescription,
    ),
  ];
}
