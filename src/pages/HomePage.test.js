import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import HomePage from './HomePage';

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

const task = (id, title, dueDate, completed = false) => ({
  id, title, level: 'daily', dueDate, completed, progress: 0, userId: 'u1',
});

const setup = (daily) => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/user') return Promise.resolve({ data: { id: 'u1', profile: { displayName: 'me', photos: [] } } });
    if (url === '/api/calendar/events') return Promise.resolve({ data: { today: [], thisWeek: [], nextWeek: [], nextMonth: [], thisMonth: [] } });
    if (url === '/api/tasks') return Promise.resolve({ data: { yearly: [], quarterly: [], monthly: [], weekly: [], daily } });
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
