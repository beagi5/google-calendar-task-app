import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './TaskManager.css';

axios.defaults.withCredentials = true;

const toDateInput = (value) => (value ? value.split('T')[0] : '');
const toTimeInput = (dateTime) => {
  if (!dateTime) return '';
  const d = new Date(dateTime);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const COMPLETED_PREFIX = '[完了] ';

const EventDetailModal = ({ event, onClose, onSaved, onDeleted }) => {
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [date, setDate] = useState('');
  const [allDay, setAllDay] = useState(true);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [wasCompleted, setWasCompleted] = useState(false);

  useEffect(() => {
    if (!event) return;
    const rawSummary = event.summary || '';
    const completed = rawSummary.startsWith(COMPLETED_PREFIX);
    setWasCompleted(completed);
    setSummary(completed ? rawSummary.slice(COMPLETED_PREFIX.length) : rawSummary);
    setDescription(event.description || '');
    setLocation(event.location || '');
    const isAllDay = !event.start?.dateTime;
    setAllDay(isAllDay);
    setDate(toDateInput(event.start?.dateTime || event.start?.date));
    setStartTime(toTimeInput(event.start?.dateTime));
    setEndTime(toTimeInput(event.end?.dateTime));
  }, [event]);

  if (!event) return null;

  const handleSave = async (e) => {
    e.preventDefault();
    if (!summary.trim() || !date) {
      setError('タイトルと日付は必須です。');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await axios.patch(`/api/calendar/events/${event.id}`, {
        summary: wasCompleted ? COMPLETED_PREFIX + summary.trim() : summary,
        description,
        location,
        date,
        allDay,
        startTime: allDay ? undefined : startTime,
        endTime: allDay ? undefined : endTime,
      });
      onSaved(response.data);
    } catch (err) {
      setError(err.response?.data?.error || '更新に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`「${event.summary}」を削除しますか？`)) return;
    setLoading(true);
    setError(null);
    try {
      await axios.delete(`/api/calendar/events/${event.id}`);
      onDeleted(event.id);
    } catch (err) {
      setError(err.response?.data?.error || '削除に失敗しました。');
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '480px' }}>
        <h3>予定を編集</h3>
        <form onSubmit={handleSave}>
          <div className="form-group">
            <label htmlFor="event-summary">タイトル *</label>
            <input
              type="text"
              id="event-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              required
            />
          </div>

          <div className="form-group checkbox-group">
            <input
              type="checkbox"
              id="event-allday"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
            />
            <label htmlFor="event-allday">終日の予定</label>
          </div>

          <div className="form-group">
            <label htmlFor="event-date">日付 *</label>
            <input
              type="date"
              id="event-date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>

          {!allDay && (
            <div style={{ display: 'flex', gap: '12px' }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label htmlFor="event-start">開始時刻</label>
                <input
                  type="time"
                  id="event-start"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label htmlFor="event-end">終了時刻</label>
                <input
                  type="time"
                  id="event-end"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="form-group">
            <label htmlFor="event-location">場所</label>
            <input
              type="text"
              id="event-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="event-description">説明</label>
            <textarea
              id="event-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={{ whiteSpace: 'pre-wrap' }}
            />
          </div>

          {event.htmlLink && (
            <div className="form-group">
              <a href={event.htmlLink} target="_blank" rel="noopener noreferrer">
                Googleカレンダーで開く
              </a>
            </div>
          )}

          {error && <div className="error-message">{error}</div>}

          <div className="form-actions" style={{ justifyContent: 'space-between' }}>
            <button type="button" onClick={handleDelete} disabled={loading} style={{ background: '#fce8e6', color: '#d93025' }}>
              削除
            </button>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="button" onClick={onClose} disabled={loading}>キャンセル</button>
              <button type="submit" disabled={loading}>{loading ? '保存中...' : '保存'}</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

export default EventDetailModal;
