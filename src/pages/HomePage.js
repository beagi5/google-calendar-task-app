import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import TaskForm from '../components/TaskForm';
import TaskItem from '../components/TaskItem';
import YarukotoItem from '../components/YarukotoItem';
import EventDetailModal from '../components/EventDetailModal';
import '../components/TaskManager.css';
import { getMondayISO, getWeekBucket } from '../utils/week';
import { getDayInfo, planYarukoto } from '../utils/day';

axios.defaults.withCredentials = true;

const CATEGORY_FILTERS = ['all', 'YCDC', '事業', '株', 'マネジメント', 'その他'];
const WEEK_FILTERS = [
  ['thisWeek', '今週'],
  ['nextWeek', '来週'],
  ['later', '後で'],
];
// サーバー(server/notion.js)が Notion の混雑のときに返す本文。未設定の 503 と見分けるために使う
const YARUKOTO_BUSY_MESSAGE = 'Notion is busy, try again later';
// 画面に戻ってきたときの読み直し(やることとカレンダー)は、これだけ間を空ける(/api の回数制限のため)
const REFRESH_INTERVAL_MS = 60 * 1000;
// 「今日は〇〇の日」の帯の色分け(種類 → CSS クラスの後ろ半分)。知らない名前は other、シフトの予定が無いときは none
const DAY_BANNER_CLASS = { 入り: 'iri', 明け: 'ake', 日勤: 'nikkin', 休み: 'yasumi', 休予: 'yasumi' };

const HomePage = () => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [calendarEvents, setCalendarEvents] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [expandedSections, setExpandedSections] = useState({ thisWeek: false, nextWeek: false, nextMonth: false });
  const toggleExpand = (key) => setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [weekFilter, setWeekFilter] = useState('thisWeek');
  // Notion の DB「やること」の「1時間」の行(サーバーが優先の順に並べて返す)。null は読み込み前
  const [yarukoto, setYarukoto] = useState(null);
  // 読めなかった理由: 'unconfigured'(サーバーに Notion の鍵が無い) / 'failed'(それ以外)
  const [yarukotoError, setYarukotoError] = useState(null);
  // チェックを Notion に書き戻せなかったときの短い知らせ
  const [yarukotoNotice, setYarukotoNotice] = useState(null);
  // 書き込み中の行の id(同じ行を続けて押させない)
  const [yarukotoPending, setYarukotoPending] = useState([]);
  // 名前を押して開いている行の id(完了条件・出典・Notionで開く が出ている行)
  const [yarukotoOpenIds, setYarukotoOpenIds] = useState([]);
  // 休みの日に畳んである「今週のやること」を開いているか
  const [restListOpen, setRestListOpen] = useState(false);
  // やることを最後に読み始めた時刻(Date.now())。画面に戻ったときの読み直しを1分に1回までにする(初回の読み込みも数える)
  const lastRefreshAt = useRef(0);
  // やることを一度でも読めたか。読めたあとの失敗では、画面の一覧をそのままにする
  const yarukotoLoaded = useRef(false);
  // 行のチェックを最後に触った時刻(id → Date.now())。読み直しの返事が来たとき、あとから触った行は手元を優先する
  const touchedAt = useRef(new Map());
  // 書き込み中の行の id(上の yarukotoPending と同じものを、描画を待たずにすぐ見られるようにした写し)
  const pendingRef = useRef([]);
  // 画面に戻ったときに動かす関数(毎回の描画で最新に差し替える)
  const refreshRef = useRef(null);

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const response = await axios.get('/api/user');
        setUser(response.data);

        // Notion は待たない: 遅くても、ほかのカードの表示を止めない
        fetchYarukoto();
        await fetchCalendarEvents();
        await fetchTasks();
      } catch (error) {
        console.log('User is not authenticated.');
      }
      setLoading(false);
    };
    
    fetchUser();
  }, []);

  const fetchCalendarEvents = async () => {
    try {
      const response = await axios.get('/api/calendar/events');
      setCalendarEvents(response.data);
    } catch (error) {
      console.error('Error fetching calendar events:', error);
    }
  };

  const fetchTasks = async () => {
    try {
      const response = await axios.get('/api/tasks');
      setTasks(response.data);
    } catch (error) {
      console.error('Error fetching tasks:', error);
    }
  };

  const fetchYarukoto = async () => {
    const startedAt = Date.now();
    lastRefreshAt.current = startedAt;
    try {
      const response = await axios.get('/api/yarukoto');
      const items = Array.isArray(response.data?.items) ? response.data.items : [];
      // 読んでいる間に自分で触った行(チェックを押した・書き込み中)は、返事より手元を優先する:
      // 返事は、その書き込みが Notion に届く前の状態かもしれない
      setYarukoto((prev) => {
        if (!prev) return items;
        const mine = new Map(prev.map((item) => [item.id, item]));
        return items.map((item) => {
          const touched = touchedAt.current.get(item.id);
          const keepMine = pendingRef.current.includes(item.id) || (touched !== undefined && touched >= startedAt);
          return keepMine && mine.has(item.id) ? mine.get(item.id) : item;
        });
      });
      yarukotoLoaded.current = true;
      setYarukotoError(null);
    } catch (error) {
      if (yarukotoLoaded.current) {
        // 一度読めたあとの失敗(混雑など)では、画面の一覧を消さない
        console.error('Error refreshing yarukoto:', error);
        return;
      }
      // 503 は「鍵が未設定」。ただし混雑のときも 503 なので、その本文のときは「読めなかった」に回す
      const notConfigured =
        error?.response?.status === 503 && error.response.data?.error !== YARUKOTO_BUSY_MESSAGE;
      setYarukoto([]);
      setYarukotoError(notConfigured ? 'unconfigured' : 'failed');
      if (!notConfigured) console.error('Error fetching yarukoto:', error);
    }
  };

  // 画面に戻ってきたとき(visibilitychange で表示に戻った・窓に focus が戻った)に、やることとカレンダーを
  // 読み直す。1分に1回まで。日付が変わっていれば、読み直したカレンダーで「今日は〇〇の日」も変わる
  const refreshWhenBack = () => {
    if (document.visibilityState === 'hidden') return;
    if (Date.now() - lastRefreshAt.current < REFRESH_INTERVAL_MS) return;
    fetchYarukoto();
    fetchCalendarEvents();
  };
  refreshRef.current = refreshWhenBack;

  useEffect(() => {
    if (!user) return undefined;
    const onBack = () => {
      if (refreshRef.current) refreshRef.current();
    };
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);
    return () => {
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('focus', onBack);
    };
  }, [user]);

  const replaceYarukoto = (id, next) =>
    setYarukoto((prev) => (prev || []).map((item) => (item.id === id ? next : item)));

  // チェック → Notion の「済」を書き換える。先に画面を変え、成功したらそのまま
  // (一覧は GET し直さない: /api の回数制限を食うため)。失敗したら元に戻して短い知らせを出す。
  // 済にした行は「いま更新した」ことにする(lastEdited): 今日済ませた行として「今日の目標」に数えるため。
  // 読み直せば Notion の本当の最終更新日時に入れ替わる。チェックを押しても、行は開閉しない
  const handleToggleYarukoto = async (item) => {
    if (pendingRef.current.includes(item.id)) return;
    const nextDone = !item.done;
    setYarukotoNotice(null);
    pendingRef.current = [...pendingRef.current, item.id];
    setYarukotoPending(pendingRef.current);
    touchedAt.current.set(item.id, Date.now());
    replaceYarukoto(item.id, { ...item, done: nextDone, lastEdited: nextDone ? new Date().toISOString() : item.lastEdited });
    try {
      await axios.patch(`/api/yarukoto/${encodeURIComponent(item.id)}`, { done: nextDone });
    } catch (error) {
      console.error('Error updating yarukoto:', error);
      replaceYarukoto(item.id, item);
      setYarukotoNotice('Notion に反映できませんでした。もう一度試してください');
    } finally {
      touchedAt.current.set(item.id, Date.now());
      pendingRef.current = pendingRef.current.filter((id) => id !== item.id);
      setYarukotoPending(pendingRef.current);
    }
  };

  // 行の名前を押すと開く(完了条件・出典・Notionで開く)。もう一度押すと閉じる
  const handleToggleYarukotoOpen = (item) =>
    setYarukotoOpenIds((prev) => (prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]));

  const handleLogin = () => {
    window.location.href = '/auth/google';
  };

  const handleLogout = () => {
    window.location.href = '/logout';
  };

  const handleTaskCreated = (newTask) => {
    fetchTasks();
  };

  const handleToggleComplete = async (task) => {
    try {
      await axios.put(`/api/tasks/${task.id}`, { completed: !task.completed });
      fetchTasks();
    } catch (error) {
      console.error('Error updating task:', error);
    }
  };

  // 持ち越し: 期日が今日より前で未完了の日次タスク(dueDateは'YYYY-MM-DD'なので文字列比較で足りる)
  const localToday = () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  };
  const isOverdueTask = (task) =>
    !task.completed && !!task.dueDate && task.dueDate.split('T')[0] < localToday();

  const carryOver = async (taskIds) => {
    try {
      await axios.post('/api/tasks/carry-over', { toDate: localToday(), ...(taskIds && { taskIds }) });
      fetchTasks();
      fetchCalendarEvents();
    } catch (error) {
      console.error('Error carrying over tasks:', error);
      window.alert('持ち越しに失敗しました。');
    }
  };

  const handleCarryOverTask = (task) => carryOver([task.id]);

  const handleEditTask = (task) => {
    setEditingTask(task);
    setShowTaskForm(true);
  };

  const handleDeleteTask = async (task) => {
    if (!window.confirm(`「${task.title}」を削除しますか？`)) return;
    try {
      await axios.delete(`/api/tasks/${task.id}`);
      fetchTasks();
    } catch (error) {
      console.error('Error deleting task:', error);
    }
  };

  const closeTaskForm = () => {
    setShowTaskForm(false);
    setEditingTask(null);
  };

  const handleEventSaved = () => {
    setSelectedEvent(null);
    fetchCalendarEvents();
  };

  const handleEventDeleted = () => {
    setSelectedEvent(null);
    fetchCalendarEvents();
  };

  const EVENT_COMPLETED_PREFIX = '[完了] ';
  const isEventCompleted = (event) => !!event.summary?.startsWith(EVENT_COMPLETED_PREFIX);
  const eventDisplayTitle = (event) =>
    isEventCompleted(event) ? event.summary.slice(EVENT_COMPLETED_PREFIX.length) : event.summary;

  const handleToggleEventComplete = async (event, e) => {
    if (e) e.stopPropagation();
    try {
      await axios.patch(`/api/calendar/events/${event.id}/complete`, { completed: !isEventCompleted(event) });
      fetchCalendarEvents();
    } catch (error) {
      console.error('Error updating event completion:', error);
    }
  };

  // タスクと予定を合わせた完了進捗(タスクはcompletedフラグ、予定は[完了]プレフィックスで判定)
  const combinedProgress = (taskList, eventList) => {
    const taskTotal = taskList?.length || 0;
    const taskCompleted = taskList?.filter((t) => t.completed).length || 0;
    const eventTotal = eventList?.length || 0;
    const eventCompleted = eventList?.filter(isEventCompleted).length || 0;
    const total = taskTotal + eventTotal;
    const completed = taskCompleted + eventCompleted;
    return { total, completed, pct: total > 0 ? Math.round((completed / total) * 100) : 0 };
  };

  // カテゴリフィルタ: 'all' は素通し。category 未設定のタスクは「その他」扱いで判定する
  const matchesCategoryFilter = (t) => categoryFilter === 'all' || (t.category || 'その他') === categoryFilter;

  const overdueTasks = (tasks?.daily?.filter(isOverdueTask) || []).filter(matchesCategoryFilter);
  const todayTasks = (tasks?.daily?.filter((t) => !isOverdueTask(t)) || []).filter(matchesCategoryFilter);
  // 絞り込み中は画面に出ている持ち越しタスクだけを移す('すべて'のときは従来どおり taskIds なし=全件)
  const handleCarryOverAll = () =>
    carryOver(categoryFilter === 'all' ? null : overdueTasks.map((t) => t.id));
  const todayProgress = combinedProgress(tasks?.daily, calendarEvents?.today);

  // Notion「やること」の行は、週(今週/来週/後で)ごとに分ける。順番はサーバーが付けた優先の順のまま。
  // 予定週が今週の月曜より前の行(先週以前の未済)は「今週」に持ち越して出す。week.js の getWeekBucket は
  // 今週・来週以外をすべて「後で」にするので、その前にここで見る('YYYY-MM-DD' なので文字列のまま比べられる)
  const yarukotoRows = yarukoto || [];
  const thisMonday = getMondayISO(new Date(), 0);
  const yarukotoBucket = (t) =>
    t.weekStart && t.weekStart < thisMonday ? 'thisWeek' : getWeekBucket(t.weekStart, new Date());
  // 週次の進捗は「今週のやることの行」＋「カレンダーの今週の予定」で数える(来週・後でのやることは含めない)
  const weekProgress = combinedProgress(
    yarukotoRows.filter((t) => yarukotoBucket(t) === 'thisWeek').map((t) => ({ completed: t.done })),
    calendarEvents?.thisWeek
  );

  // 今日がどんな日か(「今日は〇〇の日」の帯と、今日の目標の数)。カレンダーの今日の「シフト：」の予定から読む
  const dayInfo = getDayInfo(calendarEvents?.today);
  const dayBannerClass = dayInfo.kind === null ? 'none' : DAY_BANNER_CLASS[dayInfo.kind] || 'other';

  // カテゴリのボタンで絞った「やること」(このカード全体に効く。絞った中で今日の目標の数を数える)
  const yarukotoShown = yarukotoRows.filter(matchesCategoryFilter);
  // 「今週」のとき: 今日の目標 / できたら前倒し / 今週済み の振り分け
  const todayPlan = planYarukoto({
    rows: yarukotoShown,
    goal: dayInfo.goal,
    isThisWeek: (t) => yarukotoBucket(t) === 'thisWeek',
    now: new Date(),
  });
  // 「来週」「後で」のとき: 1本の一覧(未済が上、済は下。それぞれサーバーの優先の順のまま)
  const yarukotoOfWeek = yarukotoShown.filter((t) => yarukotoBucket(t) === weekFilter);
  const yarukotoPlainList = [...yarukotoOfWeek.filter((t) => !t.done), ...yarukotoOfWeek.filter((t) => t.done)];

  const renderYarukotoItem = (item) => (
    <YarukotoItem
      key={item.id}
      item={item}
      open={yarukotoOpenIds.includes(item.id)}
      disabled={yarukotoPending.includes(item.id)}
      onToggle={handleToggleYarukoto}
      onToggleOpen={handleToggleYarukotoOpen}
    />
  );
  const renderYarukotoList = (rows) =>
    rows.length > 0 ? rows.map(renderYarukotoItem) : <div className="yarukoto-message">該当するやることはありません</div>;
  const doneEarlierLine =
    todayPlan.doneEarlierCount > 0 ? (
      <div className="yarukoto-done-earlier">今週済み {todayPlan.doneEarlierCount}件</div>
    ) : null;

  const formatTime = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleTimeString('ja-JP', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  const formatDate = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('ja-JP', { 
      month: 'short', 
      day: 'numeric' 
    });
  };

  if (loading) {
    return (
      <div className="app-container">
        <div style={{ 
          display: 'flex', 
          justifyContent: 'center', 
          alignItems: 'center', 
          height: '100vh',
          fontSize: '18px',
          color: '#666'
        }}>
          読み込み中...
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="header" style={{ padding: '20px' }}>
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between',
          maxWidth: '1400px',
          margin: '0 auto'
        }}>
          <h1 style={{ 
            margin: 0, 
            background: 'linear-gradient(135deg, #667eea, #764ba2)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            fontSize: '28px',
            fontWeight: '700'
          }}>
            Task Manager Pro
          </h1>
          {user && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <button
                onClick={() => { setEditingTask(null); setShowTaskForm(true); }}
                className="create-task-btn"
              >
                新しいタスクを作成
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <img
                  src={user.profile.photos?.[0]?.value || '/logo192.png'}
                  alt="profile"
                  style={{ 
                    borderRadius: '50%', 
                    width: '40px', 
                    height: '40px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
                  }} 
                />
                <span style={{ fontWeight: '500' }}>
                  {user.profile.displayName}
                </span>
                <button 
                  onClick={handleLogout}
                  style={{
                    background: 'none',
                    border: '1px solid #ddd',
                    padding: '8px 16px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease'
                  }}
                >
                  ログアウト
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      {user ? (
        <div className="main-content fade-in">
          {/* Main Area - Today's Focus。上から: 今日は〇〇の日 → カテゴリのボタン → やること(Notion) → 今日の予定 → 今日のタスク */}
          <div className="today-section">
            {/* 今日は〇〇の日: カレンダーの今日の「シフト：」の予定から読む(使える時間から予定は差し引かない) */}
            <section className={`day-banner day-banner-${dayBannerClass}`} aria-label="今日はどんな日か">
              <div className="day-banner-title">{dayInfo.line1}</div>
              {dayInfo.line2 && <div className="day-banner-hint">{dayInfo.line2}</div>}
            </section>

            <h2 style={{
              margin: '0 0 24px 0',
              color: '#333',
              fontSize: '24px',
              fontWeight: '600',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              今日のフォーカス
            </h2>

            {/* Category filter: applies to the やること(Notion) card and the daily tasks below */}
            <div className="category-filter-button-group" style={{ marginBottom: '24px' }}>
              {CATEGORY_FILTERS.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`category-filter-btn${categoryFilter === c ? ' active' : ''}`}
                  onClick={() => setCategoryFilter(c)}
                >
                  {c === 'all' ? 'すべて' : c}
                </button>
              ))}
            </div>

            {/* Notion「やること」: 「今週」は 今日の目標 → できたら前倒し → 今週済み。「来週」「後で」は1本の一覧 */}
            <div className="yarukoto-card">
              <h3 style={{
                color: '#555',
                fontSize: '18px',
                marginBottom: '16px',
                fontWeight: '600'
              }}>
                やること（Notion）
              </h3>
              {yarukotoError ? (
                <div className="yarukoto-message">
                  {yarukotoError === 'unconfigured' ? 'Notion の鍵が未設定です' : 'Notion から読めませんでした'}
                </div>
              ) : yarukoto === null ? (
                <div className="yarukoto-message">読み込み中...</div>
              ) : (
                <>
                  <div className="week-filter-button-group" style={{ marginBottom: '12px' }}>
                    {WEEK_FILTERS.map(([key, label]) => (
                      <button
                        type="button"
                        key={key}
                        className={`week-filter-btn${weekFilter === key ? ' active' : ''}`}
                        onClick={() => setWeekFilter(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {yarukotoNotice && <div className="error-message" role="alert">{yarukotoNotice}</div>}
                  {weekFilter !== 'thisWeek' ? (
                    renderYarukotoList(yarukotoPlainList)
                  ) : (
                    <>
                      {todayPlan.mode === 'goal' && (
                        <>
                          <section className="yarukoto-section" aria-labelledby="yarukoto-goal-title">
                            <div className="yarukoto-section-head">
                              <h4 id="yarukoto-goal-title" className="yarukoto-section-title">今日の目標</h4>
                              <span className="yarukoto-section-count">済 {todayPlan.doneCount} / {todayPlan.goal}</span>
                            </div>
                            {todayPlan.achieved && <div className="yarukoto-achieved">今日の目標は達成</div>}
                            {renderYarukotoList(todayPlan.goalRows)}
                          </section>
                          {todayPlan.extraRows.length > 0 && (
                            <section className="yarukoto-section yarukoto-section-extra" aria-labelledby="yarukoto-extra-title">
                              <div className="yarukoto-section-head">
                                <h4 id="yarukoto-extra-title" className="yarukoto-section-title">できたら前倒し</h4>
                              </div>
                              {todayPlan.extraRows.map(renderYarukotoItem)}
                            </section>
                          )}
                        </>
                      )}
                      {todayPlan.mode === 'rest' && (
                        <>
                          <section className="yarukoto-section" aria-labelledby="yarukoto-goal-title">
                            <div className="yarukoto-section-head">
                              <h4 id="yarukoto-goal-title" className="yarukoto-section-title">今日の目標</h4>
                            </div>
                            <div className="yarukoto-rest">休みの日なので、事業の作業は入れません</div>
                          </section>
                          <button
                            type="button"
                            className="yarukoto-rest-toggle"
                            aria-expanded={restListOpen}
                            onClick={() => setRestListOpen((open) => !open)}
                          >
                            今週のやることを見る（{todayPlan.listRows.length}件）
                          </button>
                          {restListOpen && renderYarukotoList(todayPlan.listRows)}
                        </>
                      )}
                      {todayPlan.mode === 'free' && (
                        <>
                          <div className="yarukoto-free-note">今日の目標は出していません</div>
                          {renderYarukotoList(todayPlan.listRows)}
                        </>
                      )}
                      {doneEarlierLine}
                    </>
                  )}
                </>
              )}
            </div>

            {/* Today's Calendar Events */}
            <div style={{ marginBottom: '32px' }}>
              <h3 style={{ 
                color: '#555',
                fontSize: '18px',
                marginBottom: '16px',
                fontWeight: '600'
              }}>
                今日の予定
              </h3>
              {todayProgress.total > 0 && (
                <div style={{ marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: '#34a853', fontWeight: 600, marginBottom: '6px' }}>
                    <span>本日の進捗</span>
                    <span>{todayProgress.completed} / {todayProgress.total} 完了</span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${todayProgress.pct}%` }} />
                  </div>
                </div>
              )}
              {calendarEvents?.today?.length > 0 ? (
                <div>
                  {calendarEvents.today.map((event, index) => (
                    <div key={index} className="event-item" onClick={() => setSelectedEvent(event)} style={{
                      background: 'linear-gradient(135deg, rgba(66, 133, 244, 0.05), rgba(66, 133, 244, 0.02))',
                      border: '1px solid rgba(66, 133, 244, 0.2)',
                      borderLeft: '4px solid #4285f4',
                      padding: '16px',
                      margin: '12px 0',
                      borderRadius: '12px',
                      cursor: 'pointer'
                    }}>
                      <div style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        alignItems: 'flex-start',
                        marginBottom: '8px'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', flex: 1 }}>
                          <input
                            type="checkbox"
                            checked={isEventCompleted(event)}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => handleToggleEventComplete(event, e)}
                            style={{ marginTop: '3px' }}
                          />
                          <div style={{
                            fontWeight: '600',
                            color: '#333',
                            fontSize: '16px',
                            textDecoration: isEventCompleted(event) ? 'line-through' : 'none',
                            opacity: isEventCompleted(event) ? 0.6 : 1,
                          }}>
                            {eventDisplayTitle(event)}
                          </div>
                        </div>
                        <div style={{
                          fontSize: '12px',
                          background: event.start.dateTime ? 'rgba(66, 133, 244, 0.1)' : 'rgba(34, 197, 94, 0.1)',
                          color: event.start.dateTime ? '#4285f4' : '#22c55e',
                          padding: '4px 8px',
                          borderRadius: '12px',
                          fontWeight: '600',
                          marginLeft: '12px',
                          whiteSpace: 'nowrap'
                        }}>
                          {event.start.dateTime ? '時間指定' : '終日'}
                        </div>
                      </div>

                      {event.start.dateTime ? (
                        <div style={{ 
                          fontSize: '14px', 
                          color: '#4285f4',
                          fontWeight: '500',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          flexWrap: 'wrap'
                        }}>
                          <span>開始:</span>
                          <span style={{ 
                            background: 'rgba(66, 133, 244, 0.1)',
                            padding: '4px 10px',
                            borderRadius: '8px',
                            fontSize: '13px',
                            fontWeight: '600'
                          }}>
                            {formatTime(event.start.dateTime)}
                          </span>
                          {event.end && event.end.dateTime && (
                            <>
                              <span style={{ color: '#666' }}>〜</span>
                              <span style={{ 
                                background: 'rgba(239, 68, 68, 0.1)',
                                color: '#ef4444',
                                padding: '4px 10px',
                                borderRadius: '8px',
                                fontSize: '13px',
                                fontWeight: '600'
                              }}>
                                {formatTime(event.end.dateTime)}
                              </span>
                            </>
                          )}
                        </div>
                      ) : (
                        <div style={{ 
                          fontSize: '14px', 
                          color: '#22c55e',
                          fontWeight: '500'
                        }}>
                          一日中の予定
                        </div>
                      )}
                      
                      {event.location && (
                        <div style={{ 
                          fontSize: '13px', 
                          color: '#666',
                          marginTop: '8px',
                          fontStyle: 'italic',
                          background: 'rgba(107, 114, 128, 0.1)',
                          padding: '6px 10px',
                          borderRadius: '8px'
                        }}>
                          場所: {event.location}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ 
                  textAlign: 'center',
                  padding: '32px',
                  color: '#888',
                  background: 'rgba(248, 249, 250, 0.8)',
                  borderRadius: '12px',
                  border: '2px dashed #ddd'
                }}>
                  今日の予定はありません
                </div>
              )}
            </div>

            {/* Today's Tasks */}
            <div>
              <h3 style={{ 
                color: '#555',
                fontSize: '18px',
                marginBottom: '16px',
                fontWeight: '600'
              }}>
                今日のタスク
              </h3>
              {overdueTasks.length > 0 && (
                <div className="carry-over-section">
                  <div className="carry-over-header">
                    <span>持ち越しタスク({overdueTasks.length}件)</span>
                    <button type="button" className="carry-over-all-btn" onClick={handleCarryOverAll}>
                      すべて今日に移す
                    </button>
                  </div>
                  {overdueTasks.map((task) => (
                    <TaskItem
                      key={task.id}
                      task={task}
                      currentUserId={user.id}
                      overdue
                      onToggleComplete={handleToggleComplete}
                      onEdit={handleEditTask}
                      onDelete={handleDeleteTask}
                      onCarryOver={handleCarryOverTask}
                    />
                  ))}
                </div>
              )}
              {todayTasks.length > 0 ? (
                <div>
                  {todayTasks.map((task) => (
                    <TaskItem
                      key={task.id}
                      task={task}
                      currentUserId={user.id}
                      onToggleComplete={handleToggleComplete}
                      onEdit={handleEditTask}
                      onDelete={handleDeleteTask}
                    />
                  ))}
                </div>
              ) : (
                <div style={{
                  textAlign: 'center',
                  padding: '32px',
                  color: '#888',
                  background: 'rgba(248, 249, 250, 0.8)',
                  borderRadius: '12px',
                  border: '2px dashed #ddd'
                }}>
                  今日のタスクはありません
                  <br />
                  <button
                    onClick={() => { setEditingTask(null); setShowTaskForm(true); }}
                    style={{
                      marginTop: '16px',
                      background: 'linear-gradient(135deg, #34a853, #4caf50)',
                      color: 'white',
                      border: 'none',
                      padding: '10px 20px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '14px'
                    }}
                  >
                    タスクを作成する
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div className="sidebar">
            {/* Task Hierarchy */}
            <div className="card">
              <h3 style={{ 
                margin: '0 0 16px 0',
                color: '#333',
                fontSize: '18px',
                fontWeight: '600',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                目標の階層
              </h3>
              
              {tasks && (
                <div style={{ fontSize: '14px' }}>
                  {/* Yearly Goals */}
                  {tasks.yearly?.map((task) => (
                    <div key={task.id} className="hierarchy-item" style={{ marginBottom: '12px' }}>
                      <div style={{ fontWeight: '600', color: '#e65100', marginBottom: '4px' }}>
                        年間: {task.title}
                      </div>
                      <div style={{ fontSize: '12px', color: '#666', marginLeft: '20px' }}>
                        進捗: {task.progress}%
                      </div>
                    </div>
                  ))}
                  
                  {/* Quarterly Goals */}
                  {tasks.quarterly?.map((task) => (
                    <div key={task.id} className="hierarchy-item" style={{ marginBottom: '12px', marginLeft: '15px' }}>
                      <div style={{ fontWeight: '600', color: '#f57c00', marginBottom: '4px' }}>
                        四半期: {task.title}
                      </div>
                      <div style={{ fontSize: '12px', color: '#666', marginLeft: '20px' }}>
                        進捗: {task.progress}%
                      </div>
                    </div>
                  ))}
                  
                  {/* Monthly Goals */}
                  {tasks.monthly?.map((task) => (
                    <div key={task.id} className="hierarchy-item" style={{ marginBottom: '12px', marginLeft: '30px' }}>
                      <div style={{ fontWeight: '600', color: '#fbc02d', marginBottom: '4px' }}>
                        月間: {task.title}
                      </div>
                      <div style={{ fontSize: '12px', color: '#666', marginLeft: '20px' }}>
                        進捗: {task.progress}%
                      </div>
                    </div>
                  ))}
                  
                </div>
              )}
            </div>

            {/* This Week Overview */}
            <div className="card">
              <h3 style={{ 
                margin: '0 0 16px 0',
                color: '#333',
                fontSize: '18px',
                fontWeight: '600',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                今週の予定
              </h3>
              {weekProgress.total > 0 && (
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#34a853', fontWeight: 600, marginBottom: '4px' }}>
                    <span>週次の進捗</span>
                    <span>{weekProgress.completed} / {weekProgress.total} 完了</span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${weekProgress.pct}%` }} />
                  </div>
                </div>
              )}
              {calendarEvents?.thisWeek?.length > 0 ? (
                <div style={{ fontSize: '14px' }}>
                  {calendarEvents.thisWeek.slice(0, expandedSections.thisWeek ? undefined : 5).map((event, index) => (
                    <div key={index} onClick={() => setSelectedEvent(event)} style={{
                      margin: '8px 0',
                      padding: '10px',
                      background: 'rgba(66, 133, 244, 0.1)',
                      borderRadius: '8px',
                      border: '1px solid rgba(66, 133, 244, 0.2)',
                      cursor: 'pointer'
                    }}>
                      <div style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        alignItems: 'center',
                        marginBottom: '4px'
                      }}>
                        <div style={{ fontWeight: '600', color: '#4285f4' }}>
                          {formatDate(event.start.dateTime || event.start.date)}
                        </div>
                        <div style={{
                          fontSize: '11px',
                          background: event.start.dateTime ? 'rgba(66, 133, 244, 0.2)' : 'rgba(34, 197, 94, 0.2)',
                          color: event.start.dateTime ? '#4285f4' : '#22c55e',
                          padding: '2px 6px',
                          borderRadius: '8px',
                          fontWeight: '600'
                        }}>
                          {event.start.dateTime ? '時間' : '終日'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '4px' }}>
                        <input
                          type="checkbox"
                          checked={isEventCompleted(event)}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => handleToggleEventComplete(event, e)}
                          style={{ marginTop: '2px' }}
                        />
                        <div style={{
                          color: '#333',
                          fontWeight: '500',
                          textDecoration: isEventCompleted(event) ? 'line-through' : 'none',
                          opacity: isEventCompleted(event) ? 0.6 : 1,
                        }}>
                          {eventDisplayTitle(event)}
                        </div>
                      </div>
                      {event.start.dateTime && (
                        <div style={{
                          fontSize: '12px',
                          color: '#4285f4',
                          fontWeight: '500'
                        }}>
                          {formatTime(event.start.dateTime)}開始
                        </div>
                      )}
                    </div>
                  ))}
                  {calendarEvents.thisWeek.length > 5 && (
                    <div
                      onClick={() => toggleExpand('thisWeek')}
                      style={{ color: '#4285f4', fontWeight: 600, textAlign: 'center', marginTop: '12px', cursor: 'pointer' }}
                    >
                      {expandedSections.thisWeek ? '折りたたむ' : `...他 ${calendarEvents.thisWeek.length - 5} 件を表示`}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ 
                  textAlign: 'center',
                  padding: '24px',
                  color: '#888',
                  background: 'rgba(248, 249, 250, 0.5)',
                  borderRadius: '8px'
                }}>
                  今週の予定はありません
                </div>
              )}
            </div>

            {/* Next Week Overview */}
            <div className="card">
              <h3 style={{ 
                margin: '0 0 16px 0',
                color: '#333',
                fontSize: '18px',
                fontWeight: '600',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                来週の予定
              </h3>
              {calendarEvents?.nextWeek?.length > 0 ? (
                <div style={{ fontSize: '14px' }}>
                  {calendarEvents.nextWeek.slice(0, expandedSections.nextWeek ? undefined : 5).map((event, index) => (
                    <div key={index} onClick={() => setSelectedEvent(event)} style={{
                      margin: '8px 0',
                      padding: '10px',
                      background: 'rgba(255, 193, 7, 0.1)',
                      borderRadius: '8px',
                      border: '1px solid rgba(255, 193, 7, 0.2)',
                      cursor: 'pointer'
                    }}>
                      <div style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        alignItems: 'center',
                        marginBottom: '4px'
                      }}>
                        <div style={{ fontWeight: '600', color: '#ff9800' }}>
                          {formatDate(event.start.dateTime || event.start.date)}
                        </div>
                        <div style={{
                          fontSize: '11px',
                          background: event.start.dateTime ? 'rgba(255, 152, 0, 0.2)' : 'rgba(34, 197, 94, 0.2)',
                          color: event.start.dateTime ? '#ff9800' : '#22c55e',
                          padding: '2px 6px',
                          borderRadius: '8px',
                          fontWeight: '600'
                        }}>
                          {event.start.dateTime ? '時間' : '終日'}
                        </div>
                      </div>
                      <div style={{ color: '#333', marginBottom: '4px', fontWeight: '500' }}>
                        {event.summary}
                      </div>
                      {event.start.dateTime && (
                        <div style={{ 
                          fontSize: '12px', 
                          color: '#ff9800',
                          fontWeight: '500'
                        }}>
                          {formatTime(event.start.dateTime)}開始
                        </div>
                      )}
                    </div>
                  ))}
                  {calendarEvents.nextWeek.length > 5 && (
                    <div
                      onClick={() => toggleExpand('nextWeek')}
                      style={{ color: '#ff9800', fontWeight: 600, textAlign: 'center', marginTop: '12px', cursor: 'pointer' }}
                    >
                      {expandedSections.nextWeek ? '折りたたむ' : `...他 ${calendarEvents.nextWeek.length - 5} 件を表示`}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ 
                  textAlign: 'center',
                  padding: '24px',
                  color: '#888',
                  background: 'rgba(248, 249, 250, 0.5)',
                  borderRadius: '8px'
                }}>
                  来週の予定はありません
                </div>
              )}
            </div>

            {/* Next Month Overview */}
            <div className="card">
              <h3 style={{ 
                margin: '0 0 16px 0',
                color: '#333',
                fontSize: '18px',
                fontWeight: '600',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                来月の予定
              </h3>
              {calendarEvents?.nextMonth?.length > 0 ? (
                <div style={{ fontSize: '14px' }}>
                  {calendarEvents.nextMonth.slice(0, expandedSections.nextMonth ? undefined : 5).map((event, index) => (
                    <div key={index} onClick={() => setSelectedEvent(event)} style={{
                      margin: '8px 0',
                      padding: '10px',
                      background: 'rgba(156, 39, 176, 0.1)',
                      borderRadius: '8px',
                      border: '1px solid rgba(156, 39, 176, 0.2)',
                      cursor: 'pointer'
                    }}>
                      <div style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        alignItems: 'center',
                        marginBottom: '4px'
                      }}>
                        <div style={{ fontWeight: '600', color: '#9c27b0' }}>
                          {formatDate(event.start.dateTime || event.start.date)}
                        </div>
                        <div style={{
                          fontSize: '11px',
                          background: event.start.dateTime ? 'rgba(156, 39, 176, 0.2)' : 'rgba(34, 197, 94, 0.2)',
                          color: event.start.dateTime ? '#9c27b0' : '#22c55e',
                          padding: '2px 6px',
                          borderRadius: '8px',
                          fontWeight: '600'
                        }}>
                          {event.start.dateTime ? '時間' : '終日'}
                        </div>
                      </div>
                      <div style={{ color: '#333', marginBottom: '4px', fontWeight: '500' }}>
                        {event.summary}
                      </div>
                      {event.start.dateTime && (
                        <div style={{ 
                          fontSize: '12px', 
                          color: '#9c27b0',
                          fontWeight: '500'
                        }}>
                          {formatTime(event.start.dateTime)}開始
                        </div>
                      )}
                    </div>
                  ))}
                  {calendarEvents.nextMonth.length > 5 && (
                    <div
                      onClick={() => toggleExpand('nextMonth')}
                      style={{ color: '#9c27b0', fontWeight: 600, textAlign: 'center', marginTop: '12px', cursor: 'pointer' }}
                    >
                      {expandedSections.nextMonth ? '折りたたむ' : `...他 ${calendarEvents.nextMonth.length - 5} 件を表示`}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ 
                  textAlign: 'center',
                  padding: '24px',
                  color: '#888',
                  background: 'rgba(248, 249, 250, 0.5)',
                  borderRadius: '8px'
                }}>
                  来月の予定はありません
                </div>
              )}
            </div>

            {/* This Month Overview */}
            <div className="card">
              <h3 style={{ 
                margin: '0 0 16px 0',
                color: '#333',
                fontSize: '18px',
                fontWeight: '600',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                月間サマリー
              </h3>
              <div style={{ fontSize: '14px' }}>
                <div style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: '1px solid rgba(0,0,0,0.1)'
                }}>
                  <span>今月の予定</span>
                  <span style={{ fontWeight: '600', color: '#4285f4' }}>
                    {calendarEvents?.thisMonth?.length || 0}
                  </span>
                </div>
                <div style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: '1px solid rgba(0,0,0,0.1)'
                }}>
                  <span>来月の予定</span>
                  <span style={{ fontWeight: '600', color: '#9c27b0' }}>
                    {calendarEvents?.nextMonth?.length || 0}
                  </span>
                </div>
                <div style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: '1px solid rgba(0,0,0,0.1)'
                }}>
                  <span>今週の予定</span>
                  <span style={{ fontWeight: '600', color: '#f57c00' }}>
                    {calendarEvents?.thisWeek?.length || 0}
                  </span>
                </div>
                <div style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: '1px solid rgba(0,0,0,0.1)'
                }}>
                  <span>来週の予定</span>
                  <span style={{ fontWeight: '600', color: '#ff9800' }}>
                    {calendarEvents?.nextWeek?.length || 0}
                  </span>
                </div>
                <div style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between',
                  padding: '8px 0 0 0'
                }}>
                  <span>今日の予定</span>
                  <span style={{ fontWeight: '600', color: '#34a853' }}>
                    {calendarEvents?.today?.length || 0}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="login-container fade-in">
          <h2 style={{ 
            fontSize: '32px',
            marginBottom: '16px',
            background: 'linear-gradient(135deg, #667eea, #764ba2)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent'
          }}>
            タスク管理を始めましょう
          </h2>
          <p style={{ 
            fontSize: '18px',
            color: '#666',
            marginBottom: '32px',
            maxWidth: '500px',
            lineHeight: '1.6'
          }}>
            Googleカレンダーと連携して、効率的なタスク管理を実現します
          </p>
          <button onClick={handleLogin} className="login-btn">
            Googleでログイン
          </button>
        </div>
      )}

      {/* Task Form Modal */}
      {showTaskForm && (
        <TaskForm
          onTaskCreated={handleTaskCreated}
          onClose={closeTaskForm}
          tasks={tasks}
          task={editingTask}
        />
      )}

      {/* Calendar Event Detail/Edit Modal */}
      {selectedEvent && (
        <EventDetailModal
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          onSaved={handleEventSaved}
          onDeleted={handleEventDeleted}
        />
      )}
    </div>
  );
};

export default HomePage;