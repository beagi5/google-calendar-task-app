import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './TaskManager.css';

axios.defaults.withCredentials = true;

const isEditing = (task) => !!task;

const TaskForm = ({ onClose, onTaskCreated, task = null }) => {
  const [title, setTitle] = useState('');
  const [level, setLevel] = useState('daily');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [description, setDescription] = useState('');
  // ⭐ カレンダー連携のフラグはフロントエンドで制御し、データとして送信
  const [syncToCalendar, setSyncToCalendar] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (task) {
      setTitle(task.title || '');
      setLevel(task.level || 'daily');
      setDueDate(task.dueDate ? task.dueDate.split('T')[0] : '');
      setDescription(task.description || '');
    }
  }, [task]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // フロントエンドでの基本的な入力チェック
    if (!title || !dueDate) {
        setError("タスク名と期日は必須です。");
        setLoading(false);
        return;
    }

    try {
      let response;
      if (isEditing(task)) {
        response = await axios.put(`/api/tasks/${task.id}`, {
          title,
          description,
          dueDate,
          syncToCalendar,
        });
      } else {
        const taskData = {
          title,
          level,
          description,
          dueDate,
          dueTime: dueTime || null,
          // ⭐ バックエンドに連携要求を伝えるフラグ
          syncToCalendar,
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
            <label htmlFor="dueDate">期日 *</label>
            <input
              type="date"
              id="dueDate"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              required
            />
          </div>

          {!isEditing(task) && (
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

          {/* カレンダー連携チェックボックス(標準でON、作成・編集どちらでも切り替え可能) */}
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
