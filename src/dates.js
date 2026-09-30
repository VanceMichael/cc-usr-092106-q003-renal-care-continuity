// 纯日期（YYYY-MM-DD）工具。业务按“天”推进，不引入时刻与时区。

export function today(offsetDays = 0, base = '2026-09-30') {
  return addDays(base, offsetDays);
}

export function addDays(isoDate, delta) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(delta));
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function minDate(a, b) {
  return a == null ? b : b == null ? a : a <= b ? a : b;
}

export function maxDate(a, b) {
  return a == null ? b : b == null ? a : a >= b ? a : b;
}

// 半开区间 [start, end) 是否在 target 当日仍有效（end 为空表示长期有效）。
export function covers(start, end, target) {
  return start <= target && (end == null || target < end);
}

export function toIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`日期格式应为 YYYY-MM-DD：${String(value)}`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`非法日历日期：${value}`);
  }
  return value;
}
