import { getMondayISO, getWeekBucket } from './week';

// 2026-10-15 is a Thursday (mid-week); its Monday is 2026-10-12.
const thursday = new Date(2026, 9, 15);

test('getMondayISO returns the Monday of the week for a mid-week date', () => {
  expect(getMondayISO(thursday)).toBe('2026-10-12');
});

test('getMondayISO defaults weeksOffset to 0 (same week)', () => {
  expect(getMondayISO(thursday, 0)).toBe('2026-10-12');
});

test('getMondayISO with a positive weeksOffset returns a later Monday', () => {
  expect(getMondayISO(thursday, 1)).toBe('2026-10-19');
});

test('getMondayISO with a negative weeksOffset returns an earlier Monday', () => {
  expect(getMondayISO(thursday, -1)).toBe('2026-10-05');
});

test('getMondayISO on a Sunday still returns that week\'s Monday (week starts Monday)', () => {
  const sunday = new Date(2026, 9, 18); // 2026-10-18 is a Sunday
  expect(getMondayISO(sunday)).toBe('2026-10-12');
});

test('getMondayISO on a Monday returns itself', () => {
  const monday = new Date(2026, 9, 12);
  expect(getMondayISO(monday)).toBe('2026-10-12');
});

test('getWeekBucket returns thisWeek for the current week\'s Monday', () => {
  const thisMonday = getMondayISO(thursday, 0);
  expect(getWeekBucket(thisMonday, thursday)).toBe('thisWeek');
});

test('getWeekBucket returns nextWeek for next week\'s Monday', () => {
  const nextMonday = getMondayISO(thursday, 1);
  expect(getWeekBucket(nextMonday, thursday)).toBe('nextWeek');
});

test('getWeekBucket returns later for null', () => {
  expect(getWeekBucket(null, thursday)).toBe('later');
});

test('getWeekBucket returns later for undefined', () => {
  expect(getWeekBucket(undefined, thursday)).toBe('later');
});

test('getWeekBucket returns later for a Monday beyond next week', () => {
  const farMonday = getMondayISO(thursday, 3);
  expect(getWeekBucket(farMonday, thursday)).toBe('later');
});

test('getWeekBucket returns later for a Monday before this week', () => {
  const pastMonday = getMondayISO(thursday, -2);
  expect(getWeekBucket(pastMonday, thursday)).toBe('later');
});
