import { getDayInfo, isSameLocalDay, planYarukoto, yarukotoWeekBucket, NO_SHIFT_LINE } from './day';

const event = (summary) => ({ id: 'e', summary, start: { date: '2026-10-20' } });

// --- getDayInfo: 「今日は〇〇の日」(表の6通り) ---

test('入り (full-width colon): 今日は入りの日 / 1時間 × 6 / goal 6', () => {
  expect(getDayInfo([event('シフト：入り')])).toEqual({
    kind: '入り',
    line1: '今日は入りの日',
    line2: '使える時間の目安: 1時間 × 6',
    goal: 6,
  });
});

test('明け (half-width colon): 今日は明けの日 / 1時間 × 6（18時まで。仮眠が短い日は減らす） / goal 6', () => {
  expect(getDayInfo([event('シフト:明け')])).toEqual({
    kind: '明け',
    line1: '今日は明けの日',
    line2: '使える時間の目安: 1時間 × 6（18時まで。仮眠が短い日は減らす）',
    goal: 6,
  });
});

test('日勤 with spaces around the name (half- and full-width): 18時以降に 1時間 × 3 / goal 3', () => {
  const expected = {
    kind: '日勤',
    line1: '今日は日勤の日',
    line2: '使える時間の目安: 18時以降に 1時間 × 3',
    goal: 3,
  };
  expect(getDayInfo([event('シフト： 日勤 ')])).toEqual(expected);
  expect(getDayInfo([event('シフト:　日勤　')])).toEqual(expected);
  expect(getDayInfo([event('  シフト：日勤')])).toEqual(expected);
});

test('休み（事業）: a day off used for the business / 1時間 × 8 / goal 8 (half-width brackets and spaces too)', () => {
  const expected = {
    kind: '休み（事業）',
    line1: '今日は休み（事業）の日',
    line2: '事業に使う休み。使える時間の目安: 1時間 × 8',
    goal: 8,
  };
  expect(getDayInfo([event('シフト：休み（事業）')])).toEqual(expected);
  expect(getDayInfo([event('シフト：休み(事業)')])).toEqual(expected);
  expect(getDayInfo([event('シフト： 休み （事業） ')])).toEqual(expected);
});

test('休み（撮影） and 休み（休む）: goal 0, each with its own line', () => {
  expect(getDayInfo([event('シフト：休み（撮影）')])).toEqual({
    kind: '休み（撮影）',
    line1: '今日は休み（撮影）の日',
    line2: '撮影の日（事業のコマは入れない）',
    goal: 0,
  });
  expect(getDayInfo([event('シフト：休み(休む)')])).toEqual({
    kind: '休み（休む）',
    line1: '今日は休み（休む）の日',
    line2: '休むと決めた日（事業の作業は入れない）',
    goal: 0,
  });
});

test('休み with no use decided: the hint says so, and there is no goal (null)', () => {
  expect(getDayInfo([event('シフト：休み')])).toEqual({
    kind: '休み',
    line1: '今日は休みの日',
    line2: '休みの使い方が決まっていません（事業に使う日は 1時間 × 8。決めたらシフト名を「休み（事業）」「休み（撮影）」「休み（休む）」に）',
    goal: null,
  });
});

test('休予: goal 0 (ideas only)', () => {
  const info = getDayInfo([event('シフト：休予')]);
  expect(info.goal).toBe(0);
  expect(info.line2).toBe('事業の作業は入れない日（アイデアのメモのみ）');
});

test('a name that is not known: 今日は（名前）の日, no hint, no goal (null)', () => {
  expect(getDayInfo([event('シフト：早番')])).toEqual({
    kind: '早番',
    line1: '今日は早番の日',
    line2: null,
    goal: null,
  });
});

test('no shift in the calendar: 今日のシフトがカレンダーにありません, no hint, no goal (null)', () => {
  const none = { kind: null, line1: '今日のシフトがカレンダーにありません', line2: null, goal: null };
  expect(NO_SHIFT_LINE).toBe('今日のシフトがカレンダーにありません');
  expect(getDayInfo([])).toEqual(none);
  expect(getDayInfo(undefined)).toEqual(none);
  expect(getDayInfo(null)).toEqual(none);
  expect(getDayInfo([event('打ち合わせ'), event('歯医者')])).toEqual(none);
});

// --- getDayInfo: what is and is not a shift event ---

test('only a title that STARTS with シフト + a colon counts', () => {
  const none = getDayInfo([]);
  for (const summary of ['シフトの相談', 'シフト', 'シフト入り', 'シフト；入り', '前のシフト：入り', 'シフト ：入り', 'shift：入り']) {
    expect(getDayInfo([event(summary)])).toEqual(none);
  }
});

test('a shift with no name after the colon is not used', () => {
  expect(getDayInfo([event('シフト：')])).toEqual(getDayInfo([]));
  expect(getDayInfo([event('シフト：   ')])).toEqual(getDayInfo([]));
  // ... but a later event with a name is
  expect(getDayInfo([event('シフト：'), event('シフト：入り')]).kind).toBe('入り');
});

test('other events are skipped, and the first shift event wins', () => {
  const info = getDayInfo([event('打ち合わせ'), event('シフト：日勤'), event('シフト：入り')]);
  expect(info.kind).toBe('日勤');
});

test('a shift event that the screen marked done ([完了] in front) is still read', () => {
  expect(getDayInfo([event('[完了] シフト：入り')]).goal).toBe(6);
});

test('a bad list does not throw: no summary, not an object, names that look like object properties', () => {
  expect(() => getDayInfo([{}, null, 'シフト：入り', 5, { summary: 7 }, { summary: null }])).not.toThrow();
  expect(getDayInfo([{}, null, 'シフト：入り', 5, { summary: 7 }])).toEqual(getDayInfo([]));
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    expect(getDayInfo([event(`シフト：${name}`)])).toEqual({ kind: name, line1: `今日は${name}の日`, line2: null, goal: null });
  }
});

test('the usable time is not reduced by the day\'s other events', () => {
  const busy = [event('シフト：入り'), event('MTG 10:00'), event('MTG 14:00'), event('歯医者')];
  expect(getDayInfo(busy)).toEqual(getDayInfo([event('シフト：入り')]));
});

// --- isSameLocalDay ---

test('isSameLocalDay: the same local day, from 0:00 to 23:59:59.999', () => {
  const now = new Date(2026, 9, 20, 15, 30);
  expect(isSameLocalDay(new Date(2026, 9, 20, 0, 0, 0, 0).toISOString(), now)).toBe(true);
  expect(isSameLocalDay(new Date(2026, 9, 20, 23, 59, 59, 999).toISOString(), now)).toBe(true);
  expect(isSameLocalDay(new Date(2026, 9, 19, 23, 59, 59, 999).toISOString(), now)).toBe(false);
  expect(isSameLocalDay(new Date(2026, 9, 21, 0, 0, 0, 0).toISOString(), now)).toBe(false);
  expect(isSameLocalDay(new Date(2025, 9, 20, 12).toISOString(), now)).toBe(false);
});

test('isSameLocalDay: a value that is not a readable date is not today', () => {
  const now = new Date(2026, 9, 20, 15, 30);
  for (const value of [null, undefined, '', 'yesterday', '2026-13-45', 0, 1760000000000, {}, []]) {
    expect(isSameLocalDay(value, now)).toBe(false);
  }
});

// --- planYarukoto: 今日の目標 / できたら前倒し / 今週済み ---

const NOW = new Date(2026, 9, 20, 15, 30);
const today = (hour = 9) => new Date(2026, 9, 20, hour).toISOString();
const earlier = () => new Date(2026, 9, 18, 9).toISOString();
// week: 'this' is a row of this week; anything else is not
const row = (id, { week = 'this', done = false, lastEdited = null } = {}) => ({ id, week, done, lastEdited });
const isThisWeek = (r) => r.week === 'this';
const ids = (rows) => rows.map((r) => r.id);
const plan = (rows, goal) => planYarukoto({ rows, goal, isThisWeek, now: NOW });

test('goal 2, three unfinished rows: the first two are today\'s goal, the third is 前倒し', () => {
  const result = plan([row('p1'), row('p2'), row('p3')], 2);
  expect(result.mode).toBe('goal');
  expect(ids(result.goalRows)).toEqual(['p1', 'p2']);
  expect(ids(result.extraRows)).toEqual(['p3']);
  expect(result.doneCount).toBe(0);
  expect(result.achieved).toBe(false);
});

test('goal 2, one row done today + three unfinished: the done row and p1 are the goal, p2 and p3 are 前倒し', () => {
  const result = plan([row('d1', { week: 'later', done: true, lastEdited: today() }), row('p1'), row('p2'), row('p3')], 2);
  expect(ids(result.goalRows)).toEqual(['d1', 'p1']);
  expect(ids(result.extraRows)).toEqual(['p2', 'p3']);
  expect(result.doneCount).toBe(1);
  expect(result.achieved).toBe(false);
});

test('rows done today count whatever week they are in (this week, next week, later, last week)', () => {
  const rows = [
    row('a', { week: 'this', done: true, lastEdited: today() }),
    row('b', { week: 'next', done: true, lastEdited: today() }),
    row('c', { week: 'later', done: true, lastEdited: today() }),
    row('d', { week: 'last', done: true, lastEdited: today() }),
    row('p1'),
  ];
  const result = plan(rows, 4);
  expect(ids(result.goalRows)).toEqual(['a', 'b', 'c', 'd']);
  expect(ids(result.extraRows)).toEqual(['p1']);
  expect(result.doneCount).toBe(4);
  expect(result.achieved).toBe(true);
});

test('as many done today as the goal: achieved, and everything unfinished is 前倒し', () => {
  const result = plan([row('d1', { done: true, lastEdited: today() }), row('d2', { done: true, lastEdited: today() }), row('p1'), row('p2')], 2);
  expect(result.achieved).toBe(true);
  expect(ids(result.goalRows)).toEqual(['d1', 'd2']);
  expect(ids(result.extraRows)).toEqual(['p1', 'p2']);
});

test('more done today than the goal: all of them stay visible, the count stops at the goal', () => {
  const result = plan([row('d1', { done: true, lastEdited: today() }), row('d2', { done: true, lastEdited: today() }), row('d3', { done: true, lastEdited: today() }), row('p1')], 2);
  expect(ids(result.goalRows)).toEqual(['d1', 'd2', 'd3']);
  expect(result.doneCount).toBe(2);
  expect(result.achieved).toBe(true);
  expect(ids(result.extraRows)).toEqual(['p1']);
});

test('fewer rows than the goal: they are all in the goal, nothing is 前倒し', () => {
  const result = plan([row('p1')], 4);
  expect(ids(result.goalRows)).toEqual(['p1']);
  expect(result.extraRows).toEqual([]);
  expect(result.achieved).toBe(false);
  expect(ids(plan([], 2).goalRows)).toEqual([]);
});

test('the order of the unfinished rows is kept (the screen gets them in 優先の順)', () => {
  const result = plan([row('p3'), row('p1'), row('p2'), row('p4')], 2);
  expect(ids(result.goalRows)).toEqual(['p3', 'p1']);
  expect(ids(result.extraRows)).toEqual(['p2', 'p4']);
});

test('a row done before today (this week) is not listed: it is only counted in doneEarlierCount', () => {
  const rows = [
    row('e1', { done: true, lastEdited: earlier() }),
    row('e2', { done: true, lastEdited: null }),
    row('e3', { week: 'next', done: true, lastEdited: earlier() }), // not this week: not counted
    row('d1', { done: true, lastEdited: today() }), // today: not "earlier"
    row('p1'),
  ];
  const result = plan(rows, 2);
  expect(result.doneEarlierCount).toBe(2);
  expect(ids(result.goalRows)).toEqual(['d1', 'p1']);
  expect(ids(result.goalRows).concat(ids(result.extraRows))).not.toContain('e1');
  expect(ids(result.goalRows).concat(ids(result.extraRows))).not.toContain('e2');
});

test('unfinished rows of other weeks are not in today\'s goal or 前倒し', () => {
  const result = plan([row('n1', { week: 'next' }), row('l1', { week: 'later' }), row('p1')], 3);
  expect(ids(result.goalRows)).toEqual(['p1']);
  expect(result.extraRows).toEqual([]);
});

test('goal 0 (休み): mode rest; the list holds done-today rows first, then this week\'s unfinished rows', () => {
  const result = plan([row('p1'), row('d1', { done: true, lastEdited: today() }), row('p2'), row('e1', { done: true, lastEdited: earlier() })], 0);
  expect(result.mode).toBe('rest');
  expect(result.goal).toBe(0);
  expect(ids(result.listRows)).toEqual(['d1', 'p1', 'p2']);
  expect(result.doneEarlierCount).toBe(1);
  expect(result.goalRows).toBeUndefined();
});

test('no goal (null): mode free; one list, done-today rows first, then this week\'s unfinished rows', () => {
  const result = plan([row('p1'), row('d1', { week: 'later', done: true, lastEdited: today() }), row('p2')], null);
  expect(result.mode).toBe('free');
  expect(result.goal).toBe(null);
  expect(ids(result.listRows)).toEqual(['d1', 'p1', 'p2']);
});

test('a goal that is not a usable number is treated as "no goal"', () => {
  for (const goal of [undefined, NaN, -1, '2']) {
    expect(plan([row('p1')], goal).mode).toBe('free');
  }
});

test('planYarukoto uses the given "now" for what is today', () => {
  const rows = [row('d1', { done: true, lastEdited: new Date(2026, 9, 21, 9).toISOString() })];
  expect(ids(planYarukoto({ rows, goal: 1, isThisWeek, now: new Date(2026, 9, 21, 10) }).goalRows)).toEqual(['d1']);
  expect(planYarukoto({ rows, goal: 1, isThisWeek, now: new Date(2026, 9, 21, 10) }).achieved).toBe(true);
  expect(planYarukoto({ rows, goal: 1, isThisWeek, now: new Date(2026, 9, 22, 10) }).achieved).toBe(false);
});

// --- yarukotoWeekBucket: 今週 = 予定週が明日以前 (Notion の今週ビューと同じ, 2026-10-21) ---

test('on a weekday: this week and earlier weeks are 今週, next week is 来週, later or none is 後で', () => {
  const wed = new Date(2026, 9, 21, 12); // 2026-10-21 (水)
  expect(yarukotoWeekBucket('2026-10-19', wed)).toBe('thisWeek');
  expect(yarukotoWeekBucket('2026-10-12', wed)).toBe('thisWeek'); // 先週の持ち越し
  expect(yarukotoWeekBucket('2026-10-26', wed)).toBe('nextWeek');
  expect(yarukotoWeekBucket('2026-11-02', wed)).toBe('later');
  expect(yarukotoWeekBucket(null, wed)).toBe('later');
  expect(yarukotoWeekBucket('', wed)).toBe('later');
});

test('on Sunday, next week (its Monday is tomorrow) is already 今週; on Saturday it is still 来週', () => {
  const sun = new Date(2026, 9, 25, 9); // 2026-10-25 (日)
  const sat = new Date(2026, 9, 24, 9); // 2026-10-24 (土)
  expect(yarukotoWeekBucket('2026-10-26', sun)).toBe('thisWeek');
  expect(yarukotoWeekBucket('2026-10-19', sun)).toBe('thisWeek');
  expect(yarukotoWeekBucket('2026-11-02', sun)).toBe('later');
  expect(yarukotoWeekBucket('2026-10-26', sat)).toBe('nextWeek');
});
