import { describe, expect, it } from 'vitest';
import { RSS_DEFAULTS, type RssConfigSection } from '../src/config.ts';
import { RSS_CONFIG_KEYS, sanitizeConfigPatch } from '../src/config-save.ts';

const current: RssConfigSection = { ...RSS_DEFAULTS };

describe('sanitizeConfigPatch', () => {
  it('白名单恰好 16 个旋钮,不含 enabled', () => {
    expect(RSS_CONFIG_KEYS).toHaveLength(15);
    expect(RSS_CONFIG_KEYS).not.toContain('enabled');
  });

  it('数值夹取:越界收进区间,四舍五入,step 对齐', () => {
    expect(sanitizeConfigPatch({ pollIntervalMinutes: 0 }, current).patch.pollIntervalMinutes).toBe(1);
    expect(sanitizeConfigPatch({ pollIntervalMinutes: 9999 }, current).patch.pollIntervalMinutes).toBe(1440);
    expect(sanitizeConfigPatch({ eventMaxHeadlines: '3.6' }, current).patch.eventMaxHeadlines).toBe(4);
    expect(sanitizeConfigPatch({ requestTimeoutMs: 4321 }, current).patch.requestTimeoutMs).toBe(4500);
    expect(sanitizeConfigPatch({ pollConcurrency: '5' }, current).patch.pollConcurrency).toBe(5);
  });

  it('布尔归一:真值才为 true', () => {
    expect(sanitizeConfigPatch({ digestEnabled: true }, current).patch.digestEnabled).toBe(true);
    expect(sanitizeConfigPatch({ digestEnabled: 'yes' }, current).patch.digestEnabled).toBe(false);
  });

  it('字符串校验:digestTime 格式、trim', () => {
    expect(sanitizeConfigPatch({ digestTime: '09:30' }, current).patch.digestTime).toBe('09:30');
    expect(sanitizeConfigPatch({ watchKeywords: ' AI , 模型 ' }, current).patch.watchKeywords).toBe('AI , 模型');
    expect(() => sanitizeConfigPatch({ digestTime: '9点' }, current)).toThrow('HH:MM');
  });

  it('白名单外的键整单拒绝,enabled 不可保存', () => {
    expect(() => sanitizeConfigPatch({ enabled: true }, current)).toThrow('未知或不可保存');
    expect(() => sanitizeConfigPatch({ hacker: 1 }, current)).toThrow('未知或不可保存');
    // 整单拒绝:合法键混入非法键时一个都不写。
    expect(() => sanitizeConfigPatch({ maxFeeds: 10, hacker: 1 }, current)).toThrow();
    expect(sanitizeConfigPatch({ maxFeeds: 10 }, current).patch).toEqual({ maxFeeds: 10 });
  });

  it('restartRequired 只由保留天数触发;空补丁拒绝', () => {
    expect(sanitizeConfigPatch({ pollIntervalMinutes: 5 }, current).restartRequired).toBe(false);
    expect(sanitizeConfigPatch({ retentionDays: 60 }, current).restartRequired).toBe(true);
    // 值没变不算重启。
    expect(sanitizeConfigPatch({ retentionDays: current.retentionDays }, current).restartRequired).toBe(false);
    expect(() => sanitizeConfigPatch({}, current)).toThrow('没有要保存的配置项');
    expect(() => sanitizeConfigPatch([1, 2], current)).toThrow('对象');
  });
});
