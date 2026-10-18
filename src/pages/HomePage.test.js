import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import HomePage from './HomePage';
import { getMondayISO } from '../utils/week';

jest.mock('axios', () => ({
  __esModule: true,
  default: { defaults: {}, get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() },
}));

const pad = (n) => String(n).padStart(2, '0');
const dateStr = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const task = (id, title, dueDate, completed = false, extra = {}) => ({
  id, title, level: 'daily', dueDate, completed, progress: 0, userId: 'u1', ...extra,
});

const weeklyTask = (id, title, weekStart, completed = false) => ({
  id, title, level: 'weekly', dueDate: null, weekStart, completed, progress: 0, userId: 'u1',
});

const setup = (daily, weekly = []) => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/user') return Promise.resolve({ data: { id: 'u1', profile: { displayName: 'me', photos: [] } } });
    if (url === '/api/calendar/events') return Promise.resolve({ data: { today: [], thisWeek: [], nextWeek: [], nextMonth: [], thisMonth: [] } });
    if (url === '/api/tasks') return Promise.resolve({ data: { yearly: [], quarterly: [], monthly: [], weekly, daily } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  axios.post.mockResolvedValue({ data: { moved: 1, tasks: [] } });
};

beforeEach(() => jest.clearAllMocks());

test('overdue incomplete tasks show in the carry-over section, not in today\'s list', async () => {
  setup([
    task('a', '昨日の残り', dateStr(-1)),
    task('b', '今日の分', dateStr(0)),
    task('c', '昨日の完了済み', dateStr(-1), true),
  ]);
  render(<HomePage />);

  expect(await screen.findByText('持ち越しタスク(1件)')).toBeInTheDocument();
  // appears exactly once (in the carry-over section)
  expect(screen.getAllByText('昨日の残り')).toHaveLength(1);
  expect(screen.getByText('今日の分')).toBeInTheDocument();
  expect(screen.getByText('昨日の完了済み')).toBeInTheDocument();
});

test('no carry-over section when nothing is overdue', async () => {
  setup([task('b', '今日の分', dateStr(0)), task('d', '明日の分', dateStr(1))]);
  render(<HomePage />);

  expect(await screen.findByText('今日の分')).toBeInTheDocument();
  expect(screen.queryByText(/持ち越しタスク/)).not.toBeInTheDocument();
});

test('「今日に移す」 carries over just that task', async () => {
  setup([task('a', '昨日の残り', dateStr(-1)), task('e', '一昨日の残り', dateStr(-2))]);
  render(<HomePage />);

  await screen.findByText('持ち越しタスク(2件)');
  userEvent.click(screen.getAllByRole('button', { name: '今日に移す' })[0]);

  await waitFor(() =>
    expect(axios.post).toHaveBeenCalledWith('/api/tasks/carry-over', { toDate: dateStr(0), taskIds: ['a'] })
  );
});

test('「すべて今日に移す」 carries over everything (no taskIds)', async () => {
  setup([task('a', '昨日の残り', dateStr(-1)), task('e', '一昨日の残り', dateStr(-2))]);
  render(<HomePage />);

  await screen.findByText('持ち越しタスク(2件)');
  userEvent.click(screen.getByRole('button', { name: 'すべて今日に移す' }));

  await waitFor(() =>
    expect(axios.post).toHaveBeenCalledWith('/api/tasks/carry-over', { toDate: dateStr(0) })
  );
});

test('clicking 来週 shows only the next-week weekly task', async () => {
  const thisMonday = getMondayISO(new Date(), 0);
  const nextMonday = getMondayISO(new Date(), 1);
  setup([], [
    weeklyTask('w1', '今週のタスク', thisMonday),
    weeklyTask('w2', '来週のタスク', nextMonday),
  ]);
  render(<HomePage />);

  // デフォルトは今週の絞り込みなので、最初は今週分だけ表示されている
  await screen.findByText('今週のタスク');

  userEvent.click(screen.getByRole('button', { name: '来週' }));

  await waitFor(() => {
    expect(screen.queryByText('今週のタスク')).not.toBeInTheDocument();
    expect(screen.getByText('来週のタスク')).toBeInTheDocument();
  });
});

test('clicking a category filter button shows only that category\'s daily tasks', async () => {
  setup([
    task('a', 'YCDCのタスク', dateStr(0), false, { category: 'YCDC' }),
    task('b', '株のタスク', dateStr(0), false, { category: '株' }),
  ]);
  render(<HomePage />);

  await screen.findByText('YCDCのタスク');
  expect(screen.getByText('株のタスク')).toBeInTheDocument();

  userEvent.click(screen.getByRole('button', { name: '株' }));

  await waitFor(() => {
    expect(screen.queryByText('YCDCのタスク')).not.toBeInTheDocument();
    expect(screen.getByText('株のタスク')).toBeInTheDocument();
  });
});

test('週次の進捗 counts only this week\'s weekly tasks', async () => {
  setup([], [
    weeklyTask('w1', '今週の済み', getMondayISO(new Date(), 0), true),
    weeklyTask('w2', '来週の未済', getMondayISO(new Date(), 1)),
  ]);
  render(<HomePage />);

  // 来週のタスクを数えると「1 / 2 完了」になってしまう
  expect(await screen.findByText('1 / 1 完了')).toBeInTheDocument();
});

test('「すべて今日に移す」 while a category filter is on moves only the visible overdue tasks', async () => {
  setup([
    task('a', 'YCDCの残り', dateStr(-1), false, { category: 'YCDC' }),
    task('b', '株の残り', dateStr(-1), false, { category: '株' }),
  ]);
  render(<HomePage />);

  await screen.findByText('持ち越しタスク(2件)');
  userEvent.click(screen.getByRole('button', { name: '株' }));
  await screen.findByText('持ち越しタスク(1件)');
  userEvent.click(screen.getByRole('button', { name: 'すべて今日に移す' }));

  await waitFor(() =>
    expect(axios.post).toHaveBeenCalledWith('/api/tasks/carry-over', { toDate: dateStr(0), taskIds: ['b'] })
  );
});

test('the weekly form has no calendar-sync checkbox and sends syncToCalendar: false', async () => {
  setup([]);
  render(<HomePage />);

  userEvent.click(await screen.findByRole('button', { name: '新しいタスクを作成' }));
  expect(screen.getByLabelText('Googleカレンダーにイベントを作成する')).toBeInTheDocument();

  userEvent.selectOptions(screen.getByLabelText('期間'), 'weekly');
  expect(screen.queryByLabelText('Googleカレンダーにイベントを作成する')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('時刻(任意)')).not.toBeInTheDocument();

  userEvent.type(screen.getByLabelText('タスク名 *'), '週の作業');
  userEvent.click(screen.getByRole('button', { name: 'タスクを作成' }));

  await waitFor(() =>
    expect(axios.post).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({
      level: 'weekly', dueDate: null, syncToCalendar: false, weekStart: getMondayISO(new Date(), 0),
    }))
  );
});
