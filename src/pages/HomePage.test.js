import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import HomePage from './HomePage';
import { getMondayISO } from '../utils/week';

jest.mock('axios', () => ({
  __esModule: true,
  default: { defaults: {}, get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
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

// A row of the Notion "やること" list, as GET /api/yarukoto returns it (the server has already
// ordered the rows and worked out `category`). `lastEdited` is when Notion says it was last edited.
const yarukotoRow = (id, title, weekStart, extra = {}) => ({
  id, url: `https://www.notion.so/${id}`, title, done: false, weekStart, priority: null,
  business: null, category: 'その他', project: null, criteria: null, deadline: null, source: null, stale: null,
  lastEdited: null,
  ...extra,
});

const thisMonday = () => getMondayISO(new Date(), 0);
const nextMonday = () => getMondayISO(new Date(), 1);

// A time that is today (now) / before today, as Notion's last_edited_time text
const editedNow = () => new Date().toISOString();
const editedDaysAgo = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
};

// Today's calendar event that says what kind of day it is: シフト：入り, シフト：休み ...
const shiftEvent = (kind) => ({ id: `shift-${kind}`, summary: `シフト：${kind}`, start: { date: dateStr(0) } });

// `yarukoto`: the rows GET /api/yarukoto answers with, an error object to make that request fail,
// or a function returning the promise to answer with (to keep the request pending).
// `calendar`: parts of the calendar events to replace.
const setup = (daily, yarukoto = [], calendar = {}) => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/user') return Promise.resolve({ data: { id: 'u1', profile: { displayName: 'me', photos: [] } } });
    if (url === '/api/calendar/events') {
      return Promise.resolve({ data: { today: [], thisWeek: [], nextWeek: [], nextMonth: [], thisMonth: [], ...calendar } });
    }
    if (url === '/api/tasks') return Promise.resolve({ data: { yearly: [], quarterly: [], monthly: [], weekly: [], daily } });
    if (url === '/api/yarukoto') {
      if (typeof yarukoto === 'function') return yarukoto();
      return Array.isArray(yarukoto) ? Promise.resolve({ data: { items: yarukoto } }) : Promise.reject(yarukoto);
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  axios.post.mockResolvedValue({ data: { moved: 1, tasks: [] } });
  axios.patch.mockResolvedValue({ data: { id: 'x', done: true } });
};

// What GET /api/yarukoto fails with when the server answers `status` with `{ error }`.
const yarukotoFailure = (status, error) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error } } });

const yarukotoGets = () => axios.get.mock.calls.filter(([url]) => url === '/api/yarukoto');
const calendarGets = () => axios.get.mock.calls.filter(([url]) => url === '/api/calendar/events');

// The names of the rows in a part of the card, top to bottom (each row's checkbox is named after its row)
const rowNames = (container) => within(container).getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'));

// Coming back to the screen: the tab shows again / the window gets the focus back
const comeBackByVisibility = () => act(() => { document.dispatchEvent(new Event('visibilitychange')); });
const comeBackByFocus = () => act(() => { window.dispatchEvent(new Event('focus')); });

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

test('the やること card shows this week\'s rows by default; 来週 and 後で switch to theirs', async () => {
  setup([], [
    yarukotoRow('y1', '今週のやること', thisMonday()),
    yarukotoRow('y2', '来週のやること', nextMonday()),
    yarukotoRow('y3', '予定週なしのやること', null),
  ]);
  render(<HomePage />);

  // デフォルトは今週なので、最初は今週の行だけ表示されている
  await screen.findByText('今週のやること');
  expect(screen.queryByText('来週のやること')).not.toBeInTheDocument();
  expect(screen.queryByText('予定週なしのやること')).not.toBeInTheDocument();

  userEvent.click(screen.getByRole('button', { name: '来週' }));
  await waitFor(() => {
    expect(screen.queryByText('今週のやること')).not.toBeInTheDocument();
    expect(screen.getByText('来週のやること')).toBeInTheDocument();
    expect(screen.queryByText('予定週なしのやること')).not.toBeInTheDocument();
  });

  userEvent.click(screen.getByRole('button', { name: '後で' }));
  await waitFor(() => {
    expect(screen.queryByText('来週のやること')).not.toBeInTheDocument();
    expect(screen.getByText('予定週なしのやること')).toBeInTheDocument();
  });

  userEvent.click(screen.getByRole('button', { name: '今週' }));
  expect(await screen.findByText('今週のやること')).toBeInTheDocument();
  expect(screen.queryByText('予定週なしのやること')).not.toBeInTheDocument();
});

test('the rows stay in the order the server sent them (優先の順)', async () => {
  setup([], [
    yarukotoRow('y1', '優先1', thisMonday(), { priority: 1 }),
    yarukotoRow('y2', '優先2', thisMonday(), { priority: 2 }),
    yarukotoRow('y3', '優先なし', thisMonday()),
  ]);
  render(<HomePage />);

  await screen.findByText('優先1');
  expect(screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'))).toEqual(['優先1', '優先2', '優先なし']);
});

test('an unfinished row whose 予定週 is last week or earlier is carried over to 今週, and is not under 後で', async () => {
  setup([], [
    yarukotoRow('y1', '先週からの残り', getMondayISO(new Date(), -1), { stale: '2週以上前から' }),
    yarukotoRow('y2', '三週間前からの残り', getMondayISO(new Date(), -3)),
    yarukotoRow('y3', '今週のやること', thisMonday()),
    yarukotoRow('y4', '来週のやること', nextMonday()),
    yarukotoRow('y5', '予定週なしのやること', null),
  ]);
  render(<HomePage />);

  // 既定は今週: 持ち越しの行(サーバーが週の早い順に並べて返す)が先、今週の行が後。滞留のバッジもそのまま出る
  expect(await screen.findByText('先週からの残り')).toBeInTheDocument();
  expect(screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'))).toEqual([
    '先週からの残り', '三週間前からの残り', '今週のやること',
  ]);
  expect(screen.getByText('2週以上前から')).toBeInTheDocument();

  // 「後で」には出ない(予定週なしの行だけ)
  userEvent.click(screen.getByRole('button', { name: '後で' }));
  expect(await screen.findByText('予定週なしのやること')).toBeInTheDocument();
  expect(screen.queryByText('先週からの残り')).not.toBeInTheDocument();
  expect(screen.queryByText('三週間前からの残り')).not.toBeInTheDocument();

  // 「来週」にも出ない
  userEvent.click(screen.getByRole('button', { name: '来週' }));
  expect(await screen.findByText('来週のやること')).toBeInTheDocument();
  expect(screen.queryByText('先週からの残り')).not.toBeInTheDocument();
});

test('a carried-over row is filtered by the category buttons like any other row', async () => {
  setup([], [
    yarukotoRow('y1', '先週からのYCDC', getMondayISO(new Date(), -1), { business: 'YCDC', category: 'YCDC' }),
    yarukotoRow('y2', '先週からの株', getMondayISO(new Date(), -1), { business: '株', category: '株' }),
  ]);
  render(<HomePage />);

  await screen.findByText('先週からのYCDC');
  userEvent.click(screen.getByRole('button', { name: '株' }));
  await waitFor(() => expect(screen.queryByText('先週からのYCDC')).not.toBeInTheDocument());
  expect(screen.getByText('先週からの株')).toBeInTheDocument();
});

test('clicking a category button (事業) leaves only the やること rows whose 事業 is Webサイト', async () => {
  setup([], [
    yarukotoRow('y1', 'サイトの更新', thisMonday(), { business: 'Webサイト', category: '事業' }),
    yarukotoRow('y2', '依頼の返信', thisMonday(), { business: 'YCDC', category: 'YCDC' }),
    yarukotoRow('y3', '銘柄の確認', thisMonday(), { business: '株', category: '株' }),
    yarukotoRow('y4', '会社化の手続き', thisMonday(), { business: 'その他', category: 'マネジメント' }),
  ]);
  render(<HomePage />);

  await screen.findByText('サイトの更新');
  expect(screen.getByText('依頼の返信')).toBeInTheDocument();
  expect(screen.getByText('会社化の手続き')).toBeInTheDocument();

  userEvent.click(screen.getByRole('button', { name: '事業' }));
  await waitFor(() => {
    expect(screen.queryByText('依頼の返信')).not.toBeInTheDocument();
    expect(screen.queryByText('銘柄の確認')).not.toBeInTheDocument();
    expect(screen.queryByText('会社化の手続き')).not.toBeInTheDocument();
  });
  expect(screen.getByText('サイトの更新')).toBeInTheDocument();

  userEvent.click(screen.getByRole('button', { name: 'マネジメント' }));
  expect(await screen.findByText('会社化の手続き')).toBeInTheDocument();
  expect(screen.queryByText('サイトの更新')).not.toBeInTheDocument();

  userEvent.click(screen.getByRole('button', { name: 'すべて' }));
  expect(await screen.findByText('銘柄の確認')).toBeInTheDocument();
});

test('a row shows just the checkbox, the name and small badges; the details are not there until the name is pressed', async () => {
  setup([], [
    yarukotoRow('y1', '記事を書く', thisMonday(), {
      category: '事業', business: 'Webサイト', project: 'GEO施策', criteria: '1本公開する',
      deadline: '2026-10-25', stale: '2週以上前から', source: 'https://example.com/ref', url: 'https://www.notion.so/y1page',
    }),
    yarukotoRow('y2', '何も付いていない行', thisMonday()),
  ]);
  render(<HomePage />);

  const row = (await screen.findByRole('checkbox', { name: '記事を書く' })).closest('.yarukoto-item');
  expect(within(row).getByText('記事を書く')).toBeInTheDocument();
  expect(within(row).getByText('事業')).toBeInTheDocument();
  expect(within(row).getByText('GEO施策')).toBeInTheDocument();
  expect(within(row).getByText('10/25')).toBeInTheDocument();
  expect(within(row).getByText('2週以上前から')).toBeInTheDocument();
  // 完了条件・出典・Notionで開く は、名前を押すまで出ない
  expect(screen.queryByText('1本公開する')).not.toBeInTheDocument();
  expect(screen.queryByText('https://example.com/ref')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Notionで開く' })).not.toBeInTheDocument();
  expect(within(row).getByRole('button', { name: '記事を書く' })).toHaveAttribute('aria-expanded', 'false');

  // 完了条件・プロジェクト・締切・滞留が無い行には、そのバッジが出ない
  const bare = screen.getByRole('checkbox', { name: '何も付いていない行' }).closest('.yarukoto-item');
  expect(within(bare).queryByText('GEO施策')).not.toBeInTheDocument();
  expect(within(bare).queryByTitle('締切')).not.toBeInTheDocument();
  expect(within(bare).queryByText('2週以上前から')).not.toBeInTheDocument();
  expect(within(bare).getByText('その他')).toBeInTheDocument();
});

test('[⑫] 行の名前を押すと完了条件と出典(とNotionで開く)が出て、もう一度押すと消える。チェックを押しても開かない', async () => {
  setup([], [
    yarukotoRow('y1', '記事を書く', thisMonday(), {
      criteria: '1本公開する', source: 'https://example.com/ref', url: 'https://www.notion.so/y1page',
    }),
    yarukotoRow('y2', '別の行', thisMonday(), { criteria: '別の完了条件' }),
  ]);
  render(<HomePage />);
  await screen.findByRole('checkbox', { name: '記事を書く' });

  // 名前を押すと開く: 完了条件・出典(URL ならリンク)・「Notionで開く」(新しいタブ)
  userEvent.click(screen.getByText('記事を書く'));
  expect(screen.getByText('1本公開する')).toBeInTheDocument();
  const source = screen.getByRole('link', { name: 'https://example.com/ref' });
  expect(source).toHaveAttribute('href', 'https://example.com/ref');
  expect(source).toHaveAttribute('target', '_blank');
  expect(source).toHaveAttribute('rel', 'noopener noreferrer');
  const notionLink = screen.getByRole('link', { name: 'Notionで開く' });
  expect(notionLink).toHaveAttribute('href', 'https://www.notion.so/y1page');
  expect(notionLink).toHaveAttribute('target', '_blank');
  expect(notionLink).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByRole('button', { name: '記事を書く' })).toHaveAttribute('aria-expanded', 'true');
  // 別の行は開かない
  expect(screen.queryByText('別の完了条件')).not.toBeInTheDocument();

  // もう一度押すと閉じる
  userEvent.click(screen.getByText('記事を書く'));
  expect(screen.queryByText('1本公開する')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Notionで開く' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '記事を書く' })).toHaveAttribute('aria-expanded', 'false');

  // チェックを押しても開かない
  userEvent.click(screen.getByRole('checkbox', { name: '記事を書く' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith('/api/yarukoto/y1', { done: true }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '記事を書く' })).toBeEnabled());
  expect(screen.queryByText('1本公開する')).not.toBeInTheDocument();

  // 開いているときにチェックを押しても閉じない
  userEvent.click(screen.getByText('記事を書く'));
  expect(screen.getByText('1本公開する')).toBeInTheDocument();
  userEvent.click(screen.getByRole('checkbox', { name: '記事を書く' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '記事を書く' })).toBeEnabled());
  expect(screen.getByText('1本公開する')).toBeInTheDocument();
});

test('two rows can be open at the same time, and a row stays open when it moves between 今日の目標 and できたら前倒し', async () => {
  setup([], [
    yarukotoRow('y1', '優先1の作業', thisMonday(), { priority: 1, criteria: '条件1' }),
    yarukotoRow('y2', '優先2の作業', thisMonday(), { priority: 2, criteria: '条件2' }),
    yarukotoRow('y3', '優先3の作業', thisMonday(), { priority: 3, criteria: '条件3' }),
  ], { today: [shiftEvent('入り')] });
  render(<HomePage />);
  await screen.findByRole('region', { name: 'できたら前倒し' });

  userEvent.click(screen.getByText('優先1の作業'));
  userEvent.click(screen.getByText('優先3の作業'));
  expect(screen.getByText('条件1')).toBeInTheDocument();
  expect(screen.getByText('条件3')).toBeInTheDocument();
  expect(screen.queryByText('条件2')).not.toBeInTheDocument();

  // 前倒しにあった優先3を済にすると、今日の目標のほうへ移る。開いたまま
  userEvent.click(screen.getByRole('checkbox', { name: '優先3の作業' }));
  await waitFor(() => expect(within(screen.getByRole('region', { name: '今日の目標' })).getByRole('checkbox', { name: '優先3の作業' })).toBeChecked());
  expect(screen.getByText('条件3')).toBeInTheDocument();
  expect(screen.getByText('条件1')).toBeInTheDocument();
});

test('a source that is not a web address is shown as plain text, and a row with neither says so', async () => {
  setup([], [
    yarukotoRow('y1', '出典が文字の行', thisMonday(), { source: ['javascript', 'alert(1)'].join(':') }),
    yarukotoRow('y2', '何も無い行', thisMonday()),
  ]);
  render(<HomePage />);
  await screen.findByText('出典が文字の行');

  userEvent.click(screen.getByText('出典が文字の行'));
  expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'javascript:alert(1)' })).not.toBeInTheDocument();

  userEvent.click(screen.getByText('何も無い行'));
  expect(screen.getByText('完了条件・出典は入っていません')).toBeInTheDocument();
  // Notionで開く は、どの行にも出る
  expect(screen.getAllByRole('link', { name: 'Notionで開く' })).toHaveLength(2);
});

test('a link that is not an http(s) address is not shown as a link', async () => {
  setup([], [yarukotoRow('y1', '変なアドレスの行', thisMonday(), { url: ['javascript', 'alert(1)'].join(':') })]);
  render(<HomePage />);

  userEvent.click(await screen.findByText('変なアドレスの行'));
  expect(screen.queryByRole('link', { name: 'Notionで開く' })).not.toBeInTheDocument();
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

test('週次の進捗 counts this week\'s やること rows (plus this week\'s calendar events), not next week\'s or 後で', async () => {
  setup([], [
    yarukotoRow('y1', '今週の済み', thisMonday(), { done: true }),
    yarukotoRow('y2', '今週の未済', thisMonday()),
    yarukotoRow('y3', '来週の未済', nextMonday()),
    yarukotoRow('y4', '予定週なしの済み', null, { done: true }),
  ]);
  render(<HomePage />);

  // 来週・後での行を数えると「2 / 4 完了」などになってしまう。今週2件のうち済1件、予定は0件
  expect(await screen.findByText('1 / 2 完了')).toBeInTheDocument();
});

test('週次の進捗 adds the calendar events of this week to the やること rows', async () => {
  const thisWeekEvents = [
    { id: 'e1', summary: '[完了] 打ち合わせ', start: { date: '2026-10-20' } },
    { id: 'e2', summary: '歯医者', start: { date: '2026-10-21' } },
  ];
  setup([], [yarukotoRow('y1', '今週の済み', thisMonday(), { done: true })], { thisWeek: thisWeekEvents });
  render(<HomePage />);

  // やること 1件(済1) + 予定 2件(完了1) = 2 / 3
  expect(await screen.findByText('2 / 3 完了')).toBeInTheDocument();
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

test('checking a やること row sends axios.patch(/api/yarukoto/<id>, { done: true }) and shows it as done without a new GET', async () => {
  setup([], [yarukotoRow('y1', '今週のやること', thisMonday())]);
  render(<HomePage />);

  const checkbox = await screen.findByRole('checkbox', { name: '今週のやること' });
  expect(checkbox).not.toBeChecked();

  userEvent.click(checkbox);

  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith('/api/yarukoto/y1', { done: true }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '今週のやること' })).toBeChecked());
  // 一覧は GET し直さない(/api の回数制限を食わないため)
  expect(yarukotoGets()).toHaveLength(1);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('checking a done row again sends { done: false }; the checkbox is locked while the request is running', async () => {
  // 今日済ませた行(最終更新が今日)なので、一覧に出ている
  setup([], [yarukotoRow('y1', '済みのやること', thisMonday(), { done: true, lastEdited: editedNow() })]);
  let finish;
  axios.patch.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ data: { id: 'y1', done: false } }); }));
  render(<HomePage />);

  const checkbox = await screen.findByRole('checkbox', { name: '済みのやること' });
  expect(checkbox).toBeChecked();
  userEvent.click(checkbox);

  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith('/api/yarukoto/y1', { done: false }));
  expect(screen.getByRole('checkbox', { name: '済みのやること' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: '済みのやること' })).toBeDisabled();
  expect(axios.patch).toHaveBeenCalledTimes(1);

  finish();
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '済みのやること' })).toBeEnabled());
  expect(screen.getByRole('checkbox', { name: '済みのやること' })).not.toBeChecked();
  expect(yarukotoGets()).toHaveLength(1);
});

test('when the write fails the checkbox goes back and a short error is shown', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  setup([], [yarukotoRow('y1', '今週のやること', thisMonday())]);
  axios.patch.mockRejectedValue(Object.assign(new Error('Request failed with status code 502'), { response: { status: 502 } }));
  render(<HomePage />);

  userEvent.click(await screen.findByRole('checkbox', { name: '今週のやること' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Notion に反映できませんでした');
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '今週のやること' })).not.toBeChecked());
  expect(screen.getByRole('checkbox', { name: '今週のやること' })).toBeEnabled();
  expect(yarukotoGets()).toHaveLength(1);

  // 次に押し直して成功すれば、知らせは消える
  axios.patch.mockResolvedValue({ data: { id: 'y1', done: true } });
  userEvent.click(screen.getByRole('checkbox', { name: '今週のやること' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '今週のやること' })).toBeChecked());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  consoleError.mockRestore();
});

test('when /api/yarukoto is 503 (no Notion key), the card says so and the daily tasks still show', async () => {
  setup([task('a', '今日の分', dateStr(0))], yarukotoFailure(503, 'Notion is not configured'));
  render(<HomePage />);

  expect(await screen.findByText('Notion の鍵が未設定です')).toBeInTheDocument();
  expect(screen.getByText('今日の分')).toBeInTheDocument();
  // 週ボタンなど、読めたときだけの部品は出ない
  expect(screen.queryByRole('button', { name: '来週' })).not.toBeInTheDocument();
});

test('a 503 without a body is also read as "no Notion key"', async () => {
  setup([task('a', '今日の分', dateStr(0))], Object.assign(new Error('503'), { response: { status: 503 } }));
  render(<HomePage />);

  expect(await screen.findByText('Notion の鍵が未設定です')).toBeInTheDocument();
  expect(screen.getByText('今日の分')).toBeInTheDocument();
});

test('any other failure of /api/yarukoto (busy 503, 502, 429, no answer) says it could not be read; the daily tasks still show', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  const failures = [
    yarukotoFailure(503, 'Notion is busy, try again later'),
    yarukotoFailure(502, 'Notion request failed'),
    Object.assign(new Error('Request failed with status code 429'), { response: { status: 429, data: 'Too many API requests' } }),
    new Error('Network Error'),
  ];
  for (const failure of failures) {
    setup([task('a', '今日の分', dateStr(0))], failure);
    const { unmount } = render(<HomePage />);

    expect(await screen.findByText('Notion から読めませんでした')).toBeInTheDocument();
    expect(screen.queryByText('Notion の鍵が未設定です')).not.toBeInTheDocument();
    expect(screen.getByText('今日の分')).toBeInTheDocument();
    unmount();
  }
  consoleError.mockRestore();
});

test('while Notion is being read the card says 読み込み中... and the other cards are not held up', async () => {
  setup([task('a', '今日の分', dateStr(0))], () => new Promise(() => {}));
  render(<HomePage />);

  expect(await screen.findByText('今日の分')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'やること（Notion）' })).toBeInTheDocument();
  expect(screen.getByText('読み込み中...')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '来週' })).not.toBeInTheDocument();
});

test('a week with no rows says there is nothing for it', async () => {
  setup([], [yarukotoRow('y1', '来週のやること', nextMonday())]);
  render(<HomePage />);

  expect(await screen.findByText('該当するやることはありません')).toBeInTheDocument();
  userEvent.click(screen.getByRole('button', { name: '来週' }));
  expect(await screen.findByText('来週のやること')).toBeInTheDocument();
  expect(screen.queryByText('該当するやることはありません')).not.toBeInTheDocument();
});

test('[⑭] the やること card is in the main column (band → category buttons → card → 今日の予定 → 今日のタスク), and not in the sidebar', async () => {
  setup([task('a', '日次のタスク', dateStr(0))], [yarukotoRow('y1', '今週のやること', thisMonday())], { today: [shiftEvent('入り')] });
  render(<HomePage />);

  const cardHeading = await screen.findByRole('heading', { name: 'やること（Notion）' });
  const main = cardHeading.closest('.today-section');
  expect(main).not.toBeNull();
  expect(cardHeading.closest('.sidebar')).toBeNull();
  // サイドバーには、やることのカードも、その行も、週ボタンも無い
  const sidebar = document.querySelector('.sidebar');
  expect(within(sidebar).queryByRole('heading', { name: 'やること（Notion）' })).not.toBeInTheDocument();
  expect(within(sidebar).queryByText('今週のやること')).not.toBeInTheDocument();
  expect(within(sidebar).queryByRole('button', { name: '来週' })).not.toBeInTheDocument();
  expect(within(sidebar).getByRole('heading', { name: '今週の予定' })).toBeInTheDocument();

  const band = main.querySelector('.day-banner');
  const categoryButtons = main.querySelector('.category-filter-button-group');
  const card = cardHeading.closest('.yarukoto-card');
  const eventsHeading = within(main).getByRole('heading', { name: '今日の予定' });
  const tasksHeading = within(main).getByRole('heading', { name: '今日のタスク' });
  const comesBefore = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(main.firstElementChild).toBe(band);
  expect(comesBefore(band, categoryButtons)).toBe(true);
  expect(comesBefore(categoryButtons, card)).toBe(true);
  expect(comesBefore(card, eventsHeading)).toBe(true);
  expect(comesBefore(eventsHeading, tasksHeading)).toBe(true);
});

// --- 今日は〇〇の日 (the band) ---

test('[⑧] 今日の予定に「シフト：入り」があると、メインの列の一番上の帯に「今日は入りの日」と「1時間 × 2」が出る', async () => {
  setup([], [], { today: [shiftEvent('入り')] });
  render(<HomePage />);

  const title = await screen.findByText('今日は入りの日');
  const band = title.closest('.day-banner');
  expect(within(band).getByText('使える時間の目安: 1時間 × 2')).toBeInTheDocument();
  expect(within(band).getByText(/1時間 × 2/)).toBeInTheDocument();
  expect(band.closest('.today-section').firstElementChild).toBe(band);
  expect(band.closest('.sidebar')).toBeNull();
});

test('the band for each kind of day: 明け, 日勤, 休み, a name that is not known, and no shift in the calendar', async () => {
  const cases = [
    [[shiftEvent('明け')], '今日は明けの日', '使える時間の目安: 1時間 × 4（18時まで。仮眠が短い日は減らす）'],
    [[shiftEvent('日勤')], '今日は日勤の日', '使える時間の目安: 18時以降に軽いものを1つ'],
    [[shiftEvent('休み')], '今日は休みの日', '事業の作業は入れない日（撮影・ロケハンのみ）'],
    [[shiftEvent('早番')], '今日は早番の日', null],
    [[], '今日のシフトがカレンダーにありません', null],
    // 半角のコロン、前後の空白、シフトではない予定が混ざっていても読める
    [[{ id: 'a', summary: '歯医者', start: { date: dateStr(0) } }, { id: 'b', summary: 'シフト:  日勤 ', start: { date: dateStr(0) } }], '今日は日勤の日', '使える時間の目安: 18時以降に軽いものを1つ'],
  ];
  for (const [events, line1, line2] of cases) {
    setup([], [], { today: events });
    const { unmount } = render(<HomePage />);
    const band = (await screen.findByText(line1)).closest('.day-banner');
    if (line2) expect(within(band).getByText(line2)).toBeInTheDocument();
    else expect(band.querySelector('.day-banner-hint')).toBeNull();
    unmount();
  }
});

test('the usable time is not reduced by the other events of the day', async () => {
  setup([], [], {
    today: [shiftEvent('入り'), { id: 'm1', summary: 'MTG 10:00', start: { dateTime: new Date().toISOString() } }],
  });
  render(<HomePage />);

  const band = (await screen.findByText('今日は入りの日')).closest('.day-banner');
  expect(within(band).getByText('使える時間の目安: 1時間 × 2')).toBeInTheDocument();
});

// --- 今日の目標 / できたら前倒し / 今週済み ---

const threeRows = () => [
  yarukotoRow('y1', '優先1の作業', thisMonday(), { priority: 1 }),
  yarukotoRow('y2', '優先2の作業', thisMonday(), { priority: 2 }),
  yarukotoRow('y3', '優先3の作業', thisMonday(), { priority: 3 }),
];

test('[⑨] 入りの日、今週の未済3件(優先1・2・3): 今日の目標に1と2、できたら前倒しに3', async () => {
  setup([], threeRows(), { today: [shiftEvent('入り')] });
  render(<HomePage />);

  const goal = await screen.findByRole('region', { name: '今日の目標' });
  expect(rowNames(goal)).toEqual(['優先1の作業', '優先2の作業']);
  expect(within(goal).getByText('済 0 / 2')).toBeInTheDocument();
  const extra = screen.getByRole('region', { name: 'できたら前倒し' });
  expect(rowNames(extra)).toEqual(['優先3の作業']);
  expect(screen.queryByText('今日の目標は達成')).not.toBeInTheDocument();
});

test('[⑩] 入りの日、今日済ませた行1件(lastEdited が今日)＋今週の未済3件: 今日の目標は「済1件＋未済の優先1」、前倒しに残り2件', async () => {
  setup([], [
    // 予定週なし(=後で)の行でも、今日済ませたものは数える
    yarukotoRow('d1', '今日済ませた作業', null, { done: true, lastEdited: editedNow() }),
    ...threeRows(),
  ], { today: [shiftEvent('入り')] });
  render(<HomePage />);

  const goal = await screen.findByRole('region', { name: '今日の目標' });
  expect(rowNames(goal)).toEqual(['今日済ませた作業', '優先1の作業']);
  expect(within(goal).getByRole('checkbox', { name: '今日済ませた作業' })).toBeChecked();
  expect(within(goal).getByRole('checkbox', { name: '優先1の作業' })).not.toBeChecked();
  expect(within(goal).getByText('済 1 / 2')).toBeInTheDocument();
  expect(rowNames(screen.getByRole('region', { name: 'できたら前倒し' }))).toEqual(['優先2の作業', '優先3の作業']);
  expect(screen.queryByText('今日の目標は達成')).not.toBeInTheDocument();
});

test('as many rows done today as the goal: 「今日の目標は達成」, and every unfinished row is 前倒し', async () => {
  setup([], [
    yarukotoRow('d1', '今日済ませた作業1', thisMonday(), { done: true, lastEdited: editedNow() }),
    yarukotoRow('d2', '今日済ませた作業2', nextMonday(), { done: true, lastEdited: editedNow() }),
    ...threeRows(),
  ], { today: [shiftEvent('入り')] });
  render(<HomePage />);

  const goal = await screen.findByRole('region', { name: '今日の目標' });
  expect(within(goal).getByText('今日の目標は達成')).toBeInTheDocument();
  expect(rowNames(goal)).toEqual(['今日済ませた作業1', '今日済ませた作業2']);
  expect(within(goal).getByText('済 2 / 2')).toBeInTheDocument();
  expect(rowNames(screen.getByRole('region', { name: 'できたら前倒し' }))).toEqual(['優先1の作業', '優先2の作業', '優先3の作業']);
});

test('the number of rows in 今日の目標 follows the day: 明け 4, 日勤 1', async () => {
  const rows = [...threeRows(), yarukotoRow('y4', '優先4の作業', thisMonday(), { priority: 4 }), yarukotoRow('y5', '優先5の作業', thisMonday(), { priority: 5 })];
  for (const [kind, expected] of [['明け', 4], ['日勤', 1]]) {
    setup([], rows, { today: [shiftEvent(kind)] });
    const { unmount } = render(<HomePage />);
    const goal = await screen.findByRole('region', { name: '今日の目標' });
    expect(rowNames(goal)).toHaveLength(expected);
    expect(rowNames(screen.getByRole('region', { name: 'できたら前倒し' }))).toHaveLength(5 - expected);
    unmount();
  }
});

test('checking rows: a checked row stays in 今日の目標 as done; finishing a 前倒し row counts toward the goal and pushes the next row down', async () => {
  setup([], threeRows(), { today: [shiftEvent('入り')] });
  render(<HomePage />);
  const goalRegion = () => screen.getByRole('region', { name: '今日の目標' });
  const extraRegion = () => screen.getByRole('region', { name: 'できたら前倒し' });
  await screen.findByRole('region', { name: '今日の目標' });

  // 優先1を済にする: 今日済ませた1件(行は目標に残る)＋優先2
  userEvent.click(within(goalRegion()).getByRole('checkbox', { name: '優先1の作業' }));
  await waitFor(() => expect(within(goalRegion()).getByRole('checkbox', { name: '優先1の作業' })).toBeChecked());
  await waitFor(() => expect(within(goalRegion()).getByRole('checkbox', { name: '優先1の作業' })).toBeEnabled());
  expect(rowNames(goalRegion())).toEqual(['優先1の作業', '優先2の作業']);
  expect(within(goalRegion()).getByText('済 1 / 2')).toBeInTheDocument();
  expect(screen.queryByText('今日の目標は達成')).not.toBeInTheDocument();

  // 前倒しの優先3を済にする: 今日済ませた2件になり、目標は達成。優先2は前倒しへ
  userEvent.click(within(extraRegion()).getByRole('checkbox', { name: '優先3の作業' }));
  await waitFor(() => expect(screen.getByText('今日の目標は達成')).toBeInTheDocument());
  expect(rowNames(goalRegion())).toEqual(['優先1の作業', '優先3の作業']);
  expect(rowNames(extraRegion())).toEqual(['優先2の作業']);
  expect(yarukotoGets()).toHaveLength(1);
});

test('unchecking a row done today puts it back among the unfinished rows', async () => {
  // サーバーが優先の順(1・2・3)に並べて返した形
  setup([], [
    yarukotoRow('p1', '優先1の作業', thisMonday(), { priority: 1 }),
    yarukotoRow('d1', '今日済ませた作業', thisMonday(), { done: true, lastEdited: editedNow(), priority: 2 }),
    yarukotoRow('p3', '優先3の作業', thisMonday(), { priority: 3 }),
  ], { today: [shiftEvent('入り')] });
  render(<HomePage />);
  const goal = await screen.findByRole('region', { name: '今日の目標' });
  expect(rowNames(goal)).toEqual(['今日済ませた作業', '優先1の作業']);

  userEvent.click(within(goal).getByRole('checkbox', { name: '今日済ませた作業' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith('/api/yarukoto/d1', { done: false }));
  // 未済の優先の順(サーバーの並び): 今日済ませた作業(優先2)は優先1の次
  await waitFor(() => expect(rowNames(screen.getByRole('region', { name: '今日の目標' }))).toEqual(['優先1の作業', '今日済ませた作業']));
  expect(rowNames(screen.getByRole('region', { name: 'できたら前倒し' }))).toEqual(['優先3の作業']);
});

test('this week\'s rows done before today are not listed: only 「今週済み ○件」', async () => {
  setup([], [
    yarukotoRow('e1', '月曜に済ませた作業', thisMonday(), { done: true, lastEdited: editedDaysAgo(3) }),
    yarukotoRow('e2', '更新日時が分からない済みの作業', thisMonday(), { done: true, lastEdited: null }),
    yarukotoRow('e3', '来週の済みの作業', nextMonday(), { done: true, lastEdited: editedDaysAgo(1) }),
    yarukotoRow('d1', '今日済ませた作業', thisMonday(), { done: true, lastEdited: editedNow() }),
    yarukotoRow('p1', '優先1の作業', thisMonday(), { priority: 1 }),
  ], { today: [shiftEvent('入り')] });
  render(<HomePage />);

  const goal = await screen.findByRole('region', { name: '今日の目標' });
  expect(rowNames(goal)).toEqual(['今日済ませた作業', '優先1の作業']);
  expect(screen.getByText('今週済み 2件')).toBeInTheDocument();
  expect(screen.queryByText('月曜に済ませた作業')).not.toBeInTheDocument();
  expect(screen.queryByText('更新日時が分からない済みの作業')).not.toBeInTheDocument();
  // 週次の進捗には数える(今週の4件のうち済3件)
  expect(screen.getByText('3 / 4 完了')).toBeInTheDocument();
});

test('[⑪] 休みの日: 「休みの日なので、事業の作業は入れません」が出て、今週の一覧は畳まれ、「今週のやることを見る」を押すと出る', async () => {
  setup([], threeRows(), { today: [shiftEvent('休み')] });
  render(<HomePage />);

  expect(await screen.findByText('休みの日なので、事業の作業は入れません')).toBeInTheDocument();
  expect(screen.getByText('今日は休みの日')).toBeInTheDocument();
  // 今日の目標の場所に出ている。行は出ていない(畳んである)
  const goal = screen.getByRole('region', { name: '今日の目標' });
  expect(within(goal).getByText('休みの日なので、事業の作業は入れません')).toBeInTheDocument();
  expect(screen.queryByText('優先1の作業')).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'できたら前倒し' })).not.toBeInTheDocument();

  const toggle = screen.getByRole('button', { name: '今週のやることを見る（3件）' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  userEvent.click(toggle);
  expect(await screen.findByText('優先1の作業')).toBeInTheDocument();
  expect(screen.getByText('優先2の作業')).toBeInTheDocument();
  expect(screen.getByText('優先3の作業')).toBeInTheDocument();
  expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // もう一度押すと畳む
  userEvent.click(toggle);
  expect(screen.queryByText('優先1の作業')).not.toBeInTheDocument();
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('on a day off a row can still be checked once the list is opened, and it stays visible', async () => {
  setup([], threeRows(), { today: [shiftEvent('休み')] });
  render(<HomePage />);

  userEvent.click(await screen.findByRole('button', { name: '今週のやることを見る（3件）' }));
  userEvent.click(await screen.findByRole('checkbox', { name: '優先2の作業' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith('/api/yarukoto/y2', { done: true }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '優先2の作業' })).toBeChecked());
  expect(screen.getByRole('button', { name: '今週のやることを見る（3件）' })).toBeInTheDocument();
});

test('a day with no goal (a name that is not known, or no shift): 今日の目標は出していません, and one list of this week\'s unfinished rows', async () => {
  for (const calendar of [{ today: [shiftEvent('早番')] }, {}]) {
    setup([], [
      ...threeRows(),
      yarukotoRow('d1', '今日済ませた作業', null, { done: true, lastEdited: editedNow() }),
    ], calendar);
    const { unmount } = render(<HomePage />);

    expect(await screen.findByText('今日の目標は出していません')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '今日の目標' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'できたら前倒し' })).not.toBeInTheDocument();
    // 今日済ませた行(チェック済み)が先、そのあとに今週の未済を優先の順に
    const card = screen.getByRole('heading', { name: 'やること（Notion）' }).closest('.yarukoto-card');
    expect(rowNames(card)).toEqual(['今日済ませた作業', '優先1の作業', '優先2の作業', '優先3の作業']);
    expect(within(card).getByRole('checkbox', { name: '今日済ませた作業' })).toBeChecked();
    unmount();
  }
});

test('the category buttons apply to the whole card, and the goal is counted among the rows that are left', async () => {
  setup([], [
    yarukotoRow('d1', '株の今日済ませた作業', null, { done: true, lastEdited: editedNow(), business: '株', category: '株' }),
    yarukotoRow('y1', 'YCDCの優先1', thisMonday(), { priority: 1, business: 'YCDC', category: 'YCDC' }),
    yarukotoRow('y2', '株の優先2', thisMonday(), { priority: 2, business: '株', category: '株' }),
    yarukotoRow('y3', '株の優先3', thisMonday(), { priority: 3, business: '株', category: '株' }),
    yarukotoRow('y4', 'YCDCの優先4', thisMonday(), { priority: 4, business: 'YCDC', category: 'YCDC' }),
  ], { today: [shiftEvent('入り')] });
  render(<HomePage />);

  const goal = await screen.findByRole('region', { name: '今日の目標' });
  expect(rowNames(goal)).toEqual(['株の今日済ませた作業', 'YCDCの優先1']);

  userEvent.click(screen.getByRole('button', { name: '株' }));
  await waitFor(() => expect(rowNames(screen.getByRole('region', { name: '今日の目標' }))).toEqual(['株の今日済ませた作業', '株の優先2']));
  expect(rowNames(screen.getByRole('region', { name: 'できたら前倒し' }))).toEqual(['株の優先3']);
  expect(screen.getByText('済 1 / 2')).toBeInTheDocument();

  userEvent.click(screen.getByRole('button', { name: 'YCDC' }));
  await waitFor(() => expect(rowNames(screen.getByRole('region', { name: '今日の目標' }))).toEqual(['YCDCの優先1', 'YCDCの優先4']));
  expect(screen.queryByRole('region', { name: 'できたら前倒し' })).not.toBeInTheDocument();
  expect(screen.getByText('済 0 / 2')).toBeInTheDocument();
});

test('「来週」「後で」 are one list as before: unfinished rows on top, done rows below', async () => {
  setup([], [
    yarukotoRow('n1', '来週の済み', nextMonday(), { done: true, priority: 1, lastEdited: editedDaysAgo(1) }),
    yarukotoRow('n2', '来週の未済A', nextMonday(), { priority: 2 }),
    yarukotoRow('n3', '来週の未済B', nextMonday(), { priority: 3 }),
    yarukotoRow('l1', '後での未済', null, { priority: 1 }),
  ], { today: [shiftEvent('入り')] });
  render(<HomePage />);
  const card = (await screen.findByRole('heading', { name: 'やること（Notion）' })).closest('.yarukoto-card');

  userEvent.click(screen.getByRole('button', { name: '来週' }));
  await screen.findByText('来週の未済A');
  expect(rowNames(card)).toEqual(['来週の未済A', '来週の未済B', '来週の済み']);
  // 今日の目標などの区切りは出ない
  expect(screen.queryByRole('region', { name: '今日の目標' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'できたら前倒し' })).not.toBeInTheDocument();

  userEvent.click(screen.getByRole('button', { name: '後で' }));
  await screen.findByText('後での未済');
  expect(rowNames(card)).toEqual(['後での未済']);
});

// --- 常に新しく: 画面に戻ってきたとき ---

// Moves "now" for Date.now() only (the 1-minute wait of the refresh), so the test does not have to wait a minute
const fakeClock = () => {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  const spy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  return { advance: (ms) => { offset += ms; }, restore: () => spy.mockRestore() };
};

test('[⑬] coming back to the screen (visibilitychange) reads やること and the calendar again, at most once a minute', async () => {
  const clock = fakeClock();
  try {
    setup([], [yarukotoRow('y1', '最初の行', thisMonday())]);
    render(<HomePage />);
    await screen.findByText('最初の行');
    expect(yarukotoGets()).toHaveLength(1);
    expect(calendarGets()).toHaveLength(1);

    // 最初に読んでから1分以内に戻ってきても、読み直さない
    comeBackByVisibility();
    comeBackByVisibility();
    expect(yarukotoGets()).toHaveLength(1);
    expect(calendarGets()).toHaveLength(1);

    // 1分たってから戻ってくると読み直す。新しい中身が出る
    setup([], [yarukotoRow('y1', '最初の行', thisMonday()), yarukotoRow('y2', '読み直して出た行', thisMonday())]);
    clock.advance(61 * 1000);
    comeBackByVisibility();
    expect(await screen.findByText('読み直して出た行')).toBeInTheDocument();
    expect(yarukotoGets()).toHaveLength(2);
    expect(calendarGets()).toHaveLength(2);

    // その読み直しから1分以内の2回目(visibilitychange も focus も)は読まない
    clock.advance(30 * 1000);
    comeBackByVisibility();
    comeBackByFocus();
    expect(yarukotoGets()).toHaveLength(2);
    expect(calendarGets()).toHaveLength(2);

    // さらに1分あくと、窓に focus が戻っただけでも読む
    clock.advance(31 * 1000);
    comeBackByFocus();
    await waitFor(() => expect(yarukotoGets()).toHaveLength(3));
    expect(calendarGets()).toHaveLength(3);
    // 日次タスクは読み直さない(やることとカレンダーだけ)
    expect(axios.get.mock.calls.filter(([url]) => url === '/api/tasks')).toHaveLength(1);
  } finally {
    clock.restore();
  }
});

test('the screen being hidden (visibilityState hidden) does not read again', async () => {
  const clock = fakeClock();
  try {
    setup([], [yarukotoRow('y1', '最初の行', thisMonday())]);
    render(<HomePage />);
    await screen.findByText('最初の行');

    clock.advance(5 * 60 * 1000);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      comeBackByVisibility();
    } finally {
      delete document.visibilityState;
    }
    expect(yarukotoGets()).toHaveLength(1);
    expect(calendarGets()).toHaveLength(1);

    comeBackByVisibility();
    await waitFor(() => expect(yarukotoGets()).toHaveLength(2));
  } finally {
    clock.restore();
  }
});

test('the date changes while the screen was away: the new calendar gives a new 今日は〇〇の日, and the card follows it', async () => {
  const clock = fakeClock();
  try {
    setup([], threeRows(), { today: [shiftEvent('入り')] });
    render(<HomePage />);
    await screen.findByText('今日は入りの日');
    expect(rowNames(screen.getByRole('region', { name: '今日の目標' }))).toHaveLength(2);

    setup([], threeRows(), { today: [shiftEvent('休み')] });
    clock.advance(10 * 60 * 60 * 1000);
    comeBackByVisibility();
    expect(await screen.findByText('今日は休みの日')).toBeInTheDocument();
    expect(screen.queryByText('今日は入りの日')).not.toBeInTheDocument();
    expect(await screen.findByText('休みの日なので、事業の作業は入れません')).toBeInTheDocument();
    expect(screen.queryByText('優先1の作業')).not.toBeInTheDocument();
  } finally {
    clock.restore();
  }
});

test('a read that fails after the first one worked keeps the rows on screen (no error in the card)', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  const clock = fakeClock();
  try {
    setup([], [yarukotoRow('y1', '最初の行', thisMonday())]);
    render(<HomePage />);
    await screen.findByText('最初の行');

    setup([], yarukotoFailure(503, 'Notion is busy, try again later'));
    clock.advance(61 * 1000);
    comeBackByVisibility();
    await waitFor(() => expect(yarukotoGets()).toHaveLength(2));
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(screen.getByText('最初の行')).toBeInTheDocument();
    expect(screen.queryByText('Notion から読めませんでした')).not.toBeInTheDocument();
    expect(screen.queryByText('Notion の鍵が未設定です')).not.toBeInTheDocument();
  } finally {
    clock.restore();
    consoleError.mockRestore();
  }
});

test('a read that worked after an earlier failure takes the error away', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  const clock = fakeClock();
  try {
    setup([], yarukotoFailure(502, 'Notion request failed'));
    render(<HomePage />);
    expect(await screen.findByText('Notion から読めませんでした')).toBeInTheDocument();

    setup([], [yarukotoRow('y1', '直った後の行', thisMonday())]);
    clock.advance(61 * 1000);
    comeBackByVisibility();
    expect(await screen.findByText('直った後の行')).toBeInTheDocument();
    expect(screen.queryByText('Notion から読めませんでした')).not.toBeInTheDocument();
  } finally {
    clock.restore();
    consoleError.mockRestore();
  }
});

test('a row that is being written is not put back by a read that comes back in the meantime', async () => {
  const clock = fakeClock();
  try {
    setup([], [yarukotoRow('y1', '書き込み中の行', thisMonday())]);
    let finishWrite;
    render(<HomePage />);
    const checkbox = await screen.findByRole('checkbox', { name: '書き込み中の行' });
    axios.patch.mockImplementation(() => new Promise((resolve) => { finishWrite = () => resolve({ data: { id: 'y1', done: true } }); }));
    userEvent.click(checkbox);
    await waitFor(() => expect(axios.patch).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('checkbox', { name: '書き込み中の行' })).toBeChecked();

    // 書き込みが終わる前に読み直す: 返ってくるのは、まだ未済のまま(Notion に届く前)
    clock.advance(61 * 1000);
    comeBackByVisibility();
    await waitFor(() => expect(yarukotoGets()).toHaveLength(2));
    await act(async () => {});
    expect(screen.getByRole('checkbox', { name: '書き込み中の行' })).toBeChecked();

    await act(async () => { finishWrite(); });
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '書き込み中の行' })).toBeEnabled());
    expect(screen.getByRole('checkbox', { name: '書き込み中の行' })).toBeChecked();
  } finally {
    clock.restore();
  }
});

test('a read that began before a check is not allowed to undo it when its answer comes back late', async () => {
  const clock = fakeClock();
  try {
    setup([], [yarukotoRow('y1', '途中で押した行', thisMonday())]);
    render(<HomePage />);
    await screen.findByRole('checkbox', { name: '途中で押した行' });

    // 読み直しが始まって、返事が来ないまま待っている
    let answer;
    setup([], () => new Promise((resolve) => {
      answer = () => resolve({ data: { items: [yarukotoRow('y1', '途中で押した行', thisMonday())] } });
    }));
    clock.advance(61 * 1000);
    comeBackByVisibility();
    await waitFor(() => expect(yarukotoGets()).toHaveLength(2));

    // その間にチェックを押して、書き込みも終わる
    userEvent.click(screen.getByRole('checkbox', { name: '途中で押した行' }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '途中で押した行' })).toBeEnabled());

    // 遅れて古い返事(まだ未済)が届いても、チェックは外れない
    await act(async () => { answer(); });
    expect(screen.getByRole('checkbox', { name: '途中で押した行' })).toBeChecked();
  } finally {
    clock.restore();
  }
});

test('after a read the real last-edited time of Notion is used (a row checked here counts as done today until then)', async () => {
  const clock = fakeClock();
  try {
    setup([], [yarukotoRow('y1', '押した行', thisMonday())], { today: [shiftEvent('入り')] });
    render(<HomePage />);
    userEvent.click(await screen.findByRole('checkbox', { name: '押した行' }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: '今日の目標' })).getByRole('checkbox', { name: '押した行' })).toBeChecked());
    expect(screen.getByText('済 1 / 2')).toBeInTheDocument();

    // Notion は、この行を済で今日更新したものとして返す
    setup([], [yarukotoRow('y1', '押した行', thisMonday(), { done: true, lastEdited: editedNow() })], { today: [shiftEvent('入り')] });
    clock.advance(61 * 1000);
    comeBackByVisibility();
    await waitFor(() => expect(yarukotoGets()).toHaveLength(2));
    await act(async () => {});
    expect(screen.getByRole('checkbox', { name: '押した行' })).toBeChecked();
    expect(screen.getByText('済 1 / 2')).toBeInTheDocument();
  } finally {
    clock.restore();
  }
});

test('the 目標の階層 card no longer has the 週間タスク block', async () => {
  setup([], []);
  render(<HomePage />);

  await screen.findByRole('heading', { name: '目標の階層' });
  expect(screen.queryByText('週間タスク')).not.toBeInTheDocument();
});

test('the create form\'s 期間 has no 週間', async () => {
  setup([]);
  render(<HomePage />);

  userEvent.click(await screen.findByRole('button', { name: '新しいタスクを作成' }));
  const period = screen.getByLabelText('期間');
  expect(within(period).queryByRole('option', { name: '週間' })).not.toBeInTheDocument();
  expect(within(period).getAllByRole('option').map((option) => option.textContent)).toEqual(['年間', '四半期', '月間', '日次']);
  // 週ボタン(週の選択)も出ない
  expect(screen.queryByText('週 *')).not.toBeInTheDocument();
});

test('creating a daily task still sends its due date and the calendar-sync flag (no weekStart any more)', async () => {
  setup([]);
  render(<HomePage />);

  userEvent.click(await screen.findByRole('button', { name: '新しいタスクを作成' }));
  expect(screen.getByLabelText('Googleカレンダーにイベントを作成する')).toBeChecked();
  expect(screen.getByLabelText('時刻(任意)')).toBeInTheDocument();
  userEvent.type(screen.getByLabelText('タスク名 *'), '日次の作業');
  fireEvent.change(screen.getByLabelText(/^期日/), { target: { value: '2026-10-20' } });
  userEvent.click(screen.getByRole('button', { name: 'タスクを作成' }));

  await waitFor(() =>
    expect(axios.post).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({
      title: '日次の作業', level: 'daily', dueDate: '2026-10-20', dueTime: null, syncToCalendar: true, category: 'その他',
    }))
  );
  expect(axios.post.mock.calls[0][1]).not.toHaveProperty('weekStart');
});

test('a monthly task can be created without a due date, as before', async () => {
  setup([]);
  render(<HomePage />);

  userEvent.click(await screen.findByRole('button', { name: '新しいタスクを作成' }));
  userEvent.selectOptions(screen.getByLabelText('期間'), 'monthly');
  expect(screen.getByLabelText('期日(任意)')).toBeInTheDocument();
  userEvent.type(screen.getByLabelText('タスク名 *'), '月の目標');
  userEvent.click(screen.getByRole('button', { name: 'タスクを作成' }));

  await waitFor(() =>
    expect(axios.post).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({
      title: '月の目標', level: 'monthly', dueDate: null, syncToCalendar: true,
    }))
  );
});
