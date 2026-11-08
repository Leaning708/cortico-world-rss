/**
 * 时区时间工具:免打扰时段判定与晨报时刻计算,全部以 IANA 时区名为准(来自 ctx.timezone)。
 * 纯函数,可单测。
 */

/** "09:00" → 540;非法返回 null。 */
export function parseHm(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** "23:00-08:00" → { start: 1380, end: 480 };非法返回 null。 */
export function parseQuietHours(raw: string | null | undefined): { start: number; end: number } | null {
  if (!raw || !raw.trim()) return null;
  const match = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(raw);
  if (!match) return null;
  const start = parseHm(match[1]);
  const end = parseHm(match[2]);
  if (start == null || end == null) return null;
  return { start, end };
}

/** date 在时区里的一天第几分钟(0..1439)。 */
export function minuteOfDayIn(timezone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  // '24:xx'(kai 时制边缘)按 0 处理。
  const safeHour = hour === 24 ? 0 : hour;
  return safeHour * 60 + minute;
}

function datePartsIn(timezone: string, date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return {
    year: Number(parts.find((p) => p.type === 'year')?.value),
    month: Number(parts.find((p) => p.type === 'month')?.value),
    day: Number(parts.find((p) => p.type === 'day')?.value),
  };
}

/** date 在该时区的 UTC 偏移(毫秒) = 时区墙钟按 UTC 解释 − 真实时刻。 */
function tzOffsetMs(timezone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const hour = get('hour') === 24 ? 0 : get('hour');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - date.getTime();
}

/** 时区当天 minuteOfDay 对应的 UTC 时刻;两次迭代收敛 DST 边缘。 */
function zonedTime(timezone: string, year: number, month: number, day: number, minuteOfDay: number): Date {
  const naive = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let result = naive - tzOffsetMs(timezone, new Date(naive));
  result = naive - tzOffsetMs(timezone, new Date(result));
  return new Date(result);
}

/** 此刻是否在免打扰时段内(支持跨零点)。 */
export function isQuietNow(quiet: { start: number; end: number }, timezone: string, now: Date): boolean {
  const minute = minuteOfDayIn(timezone, now);
  if (quiet.start === quiet.end) return false;
  if (quiet.start < quiet.end) return minute >= quiet.start && minute < quiet.end;
  return minute >= quiet.start || minute < quiet.end;
}

/** 免打扰结束的下一次时刻;不在时段内返回 null。 */
export function nextQuietEnd(quiet: { start: number; end: number }, timezone: string, now: Date): Date | null {
  if (!isQuietNow(quiet, timezone, now)) return null;
  const parts = datePartsIn(timezone, now);
  let candidate = zonedTime(timezone, parts.year, parts.month, parts.day, quiet.end);
  if (candidate.getTime() <= now.getTime()) {
    const tomorrow = new Date(now.getTime() + 26 * 3600 * 1000);
    const nextParts = datePartsIn(timezone, tomorrow);
    candidate = zonedTime(timezone, nextParts.year, nextParts.month, nextParts.day, quiet.end);
  }
  return candidate;
}

/** 时区里"今天 minuteOfDay"的下一次到达时刻;若恰在此刻之后的 60s 内也算它。 */
export function nextOccurrenceOfDayTime(minuteOfDay: number, timezone: string, now: Date): Date {
  const parts = datePartsIn(timezone, now);
  let candidate = zonedTime(timezone, parts.year, parts.month, parts.day, minuteOfDay);
  if (candidate.getTime() <= now.getTime() - 60_000) {
    const tomorrow = new Date(now.getTime() + 26 * 3600 * 1000);
    const nextParts = datePartsIn(timezone, tomorrow);
    candidate = zonedTime(timezone, nextParts.year, nextParts.month, nextParts.day, minuteOfDay);
  }
  return candidate;
}

/** 相对时间的短语(收件箱/回执用)。 */
export function relativeTime(iso: string | null, now: Date, language: 'zh' | 'en'): string {
  if (!iso) return language === 'zh' ? '未知时间' : 'unknown time';
  const diffMs = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return language === 'zh' ? '未知时间' : 'unknown time';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return language === 'zh' ? '刚刚' : 'just now';
  if (minutes < 60) return language === 'zh' ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return language === 'zh' ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return language === 'zh' ? `${days} 天前` : `${days}d ago`;
  return iso.slice(0, 10);
}
