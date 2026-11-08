/**
 * 面板保存通道的纯逻辑:`config.save` 的字段白名单、数值钳制、格式校验。
 * 不依赖 DOM 或 fs——浏览器侧(表单预校验)与 Node 侧(World invoke)共用;
 * 单独成文件是为了让单测直接覆盖校验表。
 */
import { parseHm } from './chrono.ts';
import type { RssConfigSection } from './config.ts';

/** 面板可保存的字段:不含 enabled(启停由框架与部署配置决定)。 */
export type RssConfigKey = Exclude<keyof RssConfigSection, 'enabled'>;

/** 保存白名单;不在表里的键一律拒绝,避免面板把笔误写进 config.json。 */
export const RSS_CONFIG_KEYS = [
  'pollIntervalMinutes',
  'pollConcurrency',
  'requestTimeoutMs',
  'maxFeeds',
  'eventBatchSeconds',
  'eventMaxHeadlines',
  'eventMaxChars',
  'watchKeywords',
  'digestEnabled',
  'digestTime',
  'autoMarkReadOnNotify',
  'retentionDays',
  'maxItemsTotal',
  'maxItemsPerFeed',
  'baselineAsRead',
] as const satisfies readonly RssConfigKey[];

/** 数值字段的合法区间(与设计 §6.6 的 schema 一致)。 */
const NUMBER_RANGES: Partial<Record<RssConfigKey, { min: number; max: number; step?: number }>> = {
  pollIntervalMinutes: { min: 1, max: 1440 },
  pollConcurrency: { min: 1, max: 8 },
  requestTimeoutMs: { min: 3_000, max: 60_000, step: 500 },
  maxFeeds: { min: 1, max: 500 },
  eventBatchSeconds: { min: 5, max: 120 },
  eventMaxHeadlines: { min: 1, max: 20 },
  eventMaxChars: { min: 400, max: 4_000 },
  retentionDays: { min: 3, max: 365 },
  maxItemsTotal: { min: 100, max: 20_000 },
  maxItemsPerFeed: { min: 20, max: 5_000 },
};

const STRING_KEYS: readonly RssConfigKey[] = ['watchKeywords', 'digestTime'];
const BOOL_KEYS: readonly RssConfigKey[] = ['digestEnabled', 'autoMarkReadOnNotify', 'baselineAsRead'];

/** 改了要重启 World 才生效的字段(retentionDays 参与存储构造)。 */
const RESTART_KEYS: readonly RssConfigKey[] = ['retentionDays'];

export interface SanitizedConfigPatch {
  patch: Partial<RssConfigSection>;
  restartRequired: boolean;
}

function asNumber(key: RssConfigKey, raw: unknown): number {
  const range = NUMBER_RANGES[key];
  if (!range) throw new Error(`配置项 ${key} 不是数值`);
  const parsed = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error(`配置项 ${key} 必须是数字`);
  let value = Math.min(range.max, Math.max(range.min, Math.round(parsed)));
  if (range.step) value = Math.round(value / range.step) * range.step;
  return value;
}

function asString(key: RssConfigKey, raw: unknown): string {
  if (!STRING_KEYS.includes(key)) throw new Error(`配置项 ${key} 不是字符串`);
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (key === 'digestTime' && !parseHm(value)) {
    throw new Error('晨报时刻格式应为 HH:MM,例如 09:00');
  }
  return value;
}

/**
 * 校验并夹取面板提交的配置补丁。
 * 返回可安全写回的补丁;遇到白名单外的键、类型错误或格式错误时抛错(整单拒绝,不部分保存)。
 */
export function sanitizeConfigPatch(
  input: unknown,
  current: Pick<RssConfigSection, RssConfigKey>,
): SanitizedConfigPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('配置补丁必须是对象');
  }
  const raw = input as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length === 0) throw new Error('没有要保存的配置项');
  const patch: Partial<RssConfigSection> = {};
  for (const key of keys) {
    if (!(RSS_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(`未知或不可保存的配置项:${key}`);
    }
    const typed = key as RssConfigKey;
    if (BOOL_KEYS.includes(typed)) {
      (patch as Record<string, unknown>)[typed] = raw[key] === true;
    } else if (NUMBER_RANGES[typed]) {
      (patch as Record<string, unknown>)[typed] = asNumber(typed, raw[key]);
    } else {
      (patch as Record<string, unknown>)[typed] = asString(typed, raw[key]);
    }
  }
  const restartRequired = RESTART_KEYS.some((key) => key in patch && patch[key] !== current[key]);
  return { patch, restartRequired };
}
