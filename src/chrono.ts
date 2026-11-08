/**
 * 时区时间工具:晨报时刻计算与相对时间,全部以 IANA 时区名为准(来自 ctx.timezone)。
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
