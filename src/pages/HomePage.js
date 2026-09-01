import React, { useState, useEffect } from 'react';
import axios from 'axios';
import TaskForm from '../components/TaskForm';
import TaskItem from '../components/TaskItem';
import EventDetailModal from '../components/EventDetailModal';
import '../components/TaskManager.css';

axios.defaults.withCredentials = true;

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

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const response = await axios.get('/api/user');
        setUser(response.data);
        
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

  const todayProgress = combinedProgress(tasks?.daily, calendarEvents?.today);
  const weekProgress = combinedProgress(tasks?.weekly, calendarEvents?.thisWeek);

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
          {/* Main Area - Today's Focus */}
          <div className="today-section">
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
              {tasks?.daily?.length > 0 ? (
                <div>
                  {tasks.daily.map((task) => (
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
                  
                  {/* Weekly Goals */}
                  {tasks.weekly?.map((task) => (
                    <div key={task.id} className="hierarchy-item" style={{ marginBottom: '12px', marginLeft: '45px' }}>
                      <div style={{ fontWeight: '600', color: '#689f38', marginBottom: '4px' }}>
                        週間: {task.title}
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