import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './TaskManager.css';
import { getMondayISO, getWeekBucket } from '../utils/week';

axios.defaults.withCredentials = true;

const isEditing = (task) => !!task;

const CATEGORIES = ['YCDC', '事業', '株', 'マネジメント', 'その他'];

const WEEK_BUCKETS = [
  ['thisWeek', '今週'],
  ['nextWeek', '来週'],
  ['later', '後で'],
];

const TaskForm = ({ onClose, onTaskCreated, task = null }) => {
  const [title, setTitle] = useState('');
  const [level, setLevel] = useState('daily');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('その他');
  const [weekBucket, setWeekBucket] = useState('thisWeek');
  // ⭐ カレンダー連携のフラグはフロントエンドで制御し、データとして送信
  const [syncToCalendar, setSyncToCalendar] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const dueDateRequired = level === 'daily';
  const isWeekly = level === 'weekly';

  useEffect(() => {
    if (task) {
      setTitle(task.title || '');
      setLevel(task.level || 'daily');
      setDueDate(task.dueDate ? task.dueDate.split('T')[0] : '');
      setDescription(task.description || '');
      setCategory(task.category || 'その他');
      setWeekBucket(getWeekBucket(task.weekStart || null));
    }
  }, [task]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // フロントエンドでの基本的な入力チェック(期日は daily のみ必須)
    if (!title || (dueDateRequired && !dueDate)) {
        setError(dueDateRequired ? "タスク名と期日は必須です。" : "タスク名は必須です。");
        setLoading(false);
        return;
    }

    const weekStart = !isWeekly
      ? null
      : weekBucket === 'thisWeek'
        ? getMondayISO()
        : weekBucket === 'nextWeek'
          ? getMondayISO(new Date(), 1)
          : null;
    const effectiveDueDate = isWeekly ? null : (dueDate || null);
    // 週間タスクは期日を持たずカレンダーに載せないので、同期は常にオフで送る
    const effectiveSync = isWeekly ? false : syncToCalendar;

    try {
      let response;
      if (isEditing(task)) {
        response = await axios.put(`/api/tasks/${task.id}`, {
          title,
          description,
          dueDate: effectiveDueDate,
          syncToCalendar: effectiveSync,
          category,
          weekStart,
        });
      } else {
        const taskData = {
          title,
          level,
          description,
          dueDate: effectiveDueDate,
          dueTime: dueTime || null,
          // ⭐ バックエンドに連携要求を伝えるフラグ
          syncToCalendar: effectiveSync,
          category,
          weekStart,
        };
        response = await axios.post('/api/tasks', taskData);
      }

      onTaskCreated(response.data); // 親コンポーネントに通知

    } catch (err) {
      // バックエンドからのエラーレスポンスをユーザーに表示
      const errorMessage = err.response?.data?.error || err.response?.data?.message || '保存に失敗しました。';
      setError(errorMessage);

    } finally {
      setLoading(false);
      onClose(); // エラーがあっても閉じるか、条件付きで閉じるかを選択（ここでは閉じる）
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '450px' }}>
        <h3>{isEditing(task) ? 'タスクを編集' : '新しいタスクを作成'}</h3>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="title">タスク名 *</label>
            <input
              type="text"
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="level">期間</label>
            <select id="level" value={level} onChange={(e) => setLevel(e.target.value)} disabled={isEditing(task)}>
              <option value="yearly">年間</option>
              <option value="quarterly">四半期</option>
              <option value="monthly">月間</option>
              <option value="weekly">週間</option>
              <option value="daily">日次</option>
            </select>
          </div>

          <div className="form-group">
            <label>カテゴリ</label>
            <div className="category-button-group">
              {CATEGORIES.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`category-btn${category === c ? ' active' : ''}`}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {isWeekly ? (
            <div className="form-group">
              <label>週 *</label>
              <div className="week-bucket-button-group">
                {WEEK_BUCKETS.map(([key, label]) => (
                  <button
                    type="button"
                    key={key}
                    className={`week-bucket-btn${weekBucket === key ? ' active' : ''}`}
                    onClick={() => setWeekBucket(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="form-group">
              <label htmlFor="dueDate">期日{dueDateRequired ? ' *' : '(任意)'}</label>
              <input
                type="date"
                id="dueDate"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                required={dueDateRequired}
              />
            </div>
          )}

          {!isEditing(task) && !isWeekly && (
            <div className="form-group">
              <label htmlFor="dueTime">時刻(任意)</label>
              <input
                type="time"
                id="dueTime"
                value={dueTime}
                onChange={(e) => setDueTime(e.target.value)}
              />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="description">説明</label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          {/* カレンダー連携チェックボックス(標準でON、作成・編集どちらでも切り替え可能)。週間タスクは期日が無く同期しないので出さない */}
          {!isWeekly && (
            <div className="form-group checkbox-group">
                <input
                    type="checkbox"
                    id="syncCalendar"
                    checked={syncToCalendar}
                    onChange={(e) => setSyncToCalendar(e.target.checked)}
                />
                <label htmlFor="syncCalendar">
                    Googleカレンダーにイベントを作成する
                </label>
            </div>
          )}

          {error && <div className="error-message">{error}</div>}

          <div className="form-actions">
              <button type="button" onClick={onClose} disabled={loading}>キャンセル</button>
              <button type="submit" disabled={loading}>
                  {loading ? '保存中...' : (isEditing(task) ? '更新' : 'タスクを作成')}
              </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default TaskForm;
