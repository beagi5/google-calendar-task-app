// Pure date helpers for weekly task bucketing (今週・来週・後で).
// Everything here works in local time, matching HomePage's localToday()/dueDate handling
// (both treat 'YYYY-MM-DD' as a local calendar date, not UTC).

const pad = (n) => String(n).padStart(2, '0');

const toISO = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// The Monday ('YYYY-MM-DD', local time) of the week containing `date`,
// optionally shifted by `weeksOffset` whole weeks (e.g. 1 = next week's Monday).
export const getMondayISO = (date = new Date(), weeksOffset = 0) => {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday + weeksOffset * 7);
  return toISO(d);
};

// Buckets a task's weekStart ('YYYY-MM-DD' Monday, or null/undefined) relative to `today`:
// - this week's Monday -> 'thisWeek'
// - next week's Monday  -> 'nextWeek'
// - anything else (including null/undefined) -> 'later'
export const getWeekBucket = (weekStart, today = new Date()) => {
  if (!weekStart) return 'later';
  if (weekStart === getMondayISO(today, 0)) return 'thisWeek';
  if (weekStart === getMondayISO(today, 1)) return 'nextWeek';
  return 'later';
};
