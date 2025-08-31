import React, { useState, useEffect } from 'react';
import axios from 'axios';

// Configure axios to send credentials with requests
axios.defaults.withCredentials = true;

const HomePage = () => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [calendarEvents, setCalendarEvents] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [activeView, setActiveView] = useState('today');

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const response = await axios.get('http://localhost:3001/api/user');
        setUser(response.data);
        
        // Fetch calendar events and tasks after user is authenticated
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
      const response = await axios.get('http://localhost:3001/api/calendar/events');
      setCalendarEvents(response.data);
    } catch (error) {
      console.error('Error fetching calendar events:', error);
    }
  };

  const fetchTasks = async () => {
    try {
      const response = await axios.get('http://localhost:3001/api/tasks');
      setTasks(response.data);
    } catch (error) {
      console.error('Error fetching tasks:', error);
    }
  };

  const handleLogin = () => {
    window.location.href = 'http://localhost:3001/auth/google';
  };

  const handleLogout = () => {
    window.location.href = 'http://localhost:3001/logout';
  };

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
    return <div style={{ padding: '20px' }}>Loading...</div>;
  }

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <header style={{ borderBottom: '2px solid #e0e0e0', paddingBottom: '10px', marginBottom: '20px' }}>
        <h1>Google Calendar Task Manager</h1>
        {user && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
            <img 
              src={user.profile.photos[0].value} 
              alt="profile" 
              style={{ borderRadius: '50%', width: '40px', height: '40px' }} 
            />
            <span>Welcome, {user.profile.displayName}!</span>
            <button onClick={handleLogout} style={{ marginLeft: 'auto' }}>Logout</button>
          </div>
        )}
      </header>

      {user ? (
        <div style={{ display: 'flex', gap: '20px' }}>
          {/* Main Area - Today's Focus */}
          <div style={{ flex: '2', backgroundColor: '#f8f9fa', padding: '20px', borderRadius: '8px' }}>
            <h2>📅 今日のタスク</h2>
            
            {/* Today's Calendar Events */}
            <div style={{ marginBottom: '20px' }}>
              <h3>今日の予定</h3>
              {calendarEvents?.today?.length > 0 ? (
                <ul style={{ listStyle: 'none', padding: 0 }}>
                  {calendarEvents.today.map((event, index) => (
                    <li key={index} style={{ 
                      backgroundColor: 'white', 
                      padding: '10px', 
                      margin: '5px 0', 
                      borderRadius: '5px',
                      borderLeft: '4px solid #4285f4'
                    }}>
                      <strong>{event.summary}</strong>
                      {event.start.dateTime && (
                        <span style={{ marginLeft: '10px', color: '#666' }}>
                          {formatTime(event.start.dateTime)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={{ color: '#666' }}>今日の予定はありません</p>
              )}
            </div>

            {/* Today's Tasks */}
            <div>
              <h3>今日のタスク</h3>
              {tasks?.daily?.length > 0 ? (
                <ul style={{ listStyle: 'none', padding: 0 }}>
                  {tasks.daily.map((task) => (
                    <li key={task.id} style={{ 
                      backgroundColor: 'white', 
                      padding: '15px', 
                      margin: '10px 0', 
                      borderRadius: '5px',
                      borderLeft: '4px solid #34a853'
                    }}>
                      <strong>{task.title}</strong>
                      <p style={{ margin: '5px 0', color: '#666' }}>{task.description}</p>
                      <div style={{ fontSize: '14px', color: '#888' }}>
                        進捗: {task.progress}%
                        <div style={{ 
                          backgroundColor: '#e0e0e0', 
                          height: '6px', 
                          borderRadius: '3px', 
                          marginTop: '5px' 
                        }}>
                          <div style={{ 
                            backgroundColor: '#34a853', 
                            height: '100%', 
                            width: `${task.progress}%`, 
                            borderRadius: '3px' 
                          }}></div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={{ color: '#666' }}>今日のタスクはありません</p>
              )}
            </div>
          </div>

          {/* Side Area - Week and Month Overview */}
          <div style={{ flex: '1' }}>
            {/* Task Hierarchy */}
            <div style={{ backgroundColor: '#fff3e0', padding: '15px', borderRadius: '8px', marginBottom: '20px' }}>
              <h3>🎯 目標の階層</h3>
              
              {tasks && (
                <div style={{ fontSize: '14px' }}>
                  {/* Yearly Goals */}
                  {tasks.yearly?.map((task) => (
                    <div key={task.id} style={{ marginBottom: '10px' }}>
                      <div style={{ fontWeight: 'bold', color: '#e65100' }}>📅 年間: {task.title}</div>
                      <div style={{ fontSize: '12px', color: '#666', marginLeft: '20px' }}>進捗: {task.progress}%</div>
                    </div>
                  ))}
                  
                  {/* Quarterly Goals */}
                  {tasks.quarterly?.map((task) => (
                    <div key={task.id} style={{ marginBottom: '10px', marginLeft: '15px' }}>
                      <div style={{ fontWeight: 'bold', color: '#f57c00' }}>📊 四半期: {task.title}</div>
                      <div style={{ fontSize: '12px', color: '#666', marginLeft: '20px' }}>進捗: {task.progress}%</div>
                    </div>
                  ))}
                  
                  {/* Monthly Goals */}
                  {tasks.monthly?.map((task) => (
                    <div key={task.id} style={{ marginBottom: '10px', marginLeft: '30px' }}>
                      <div style={{ fontWeight: 'bold', color: '#fbc02d' }}>📅 月間: {task.title}</div>
                      <div style={{ fontSize: '12px', color: '#666', marginLeft: '20px' }}>進捗: {task.progress}%</div>
                    </div>
                  ))}
                  
                  {/* Weekly Goals */}
                  {tasks.weekly?.map((task) => (
                    <div key={task.id} style={{ marginBottom: '10px', marginLeft: '45px' }}>
                      <div style={{ fontWeight: 'bold', color: '#689f38' }}>📝 週間: {task.title}</div>
                      <div style={{ fontSize: '12px', color: '#666', marginLeft: '20px' }}>進捗: {task.progress}%</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* This Week Overview */}
            <div style={{ backgroundColor: '#e3f2fd', padding: '15px', borderRadius: '8px', marginBottom: '20px' }}>
              <h3>📆 今週の予定</h3>
              {calendarEvents?.thisWeek?.length > 0 ? (
                <ul style={{ listStyle: 'none', padding: 0, fontSize: '14px' }}>
                  {calendarEvents.thisWeek.slice(0, 5).map((event, index) => (
                    <li key={index} style={{ margin: '5px 0' }}>
                      <strong>{formatDate(event.start.dateTime || event.start.date)}</strong>: {event.summary}
                    </li>
                  ))}
                  {calendarEvents.thisWeek.length > 5 && (
                    <li style={{ color: '#666', fontStyle: 'italic' }}>
                      ...他 {calendarEvents.thisWeek.length - 5} 件
                    </li>
                  )}
                </ul>
              ) : (
                <p style={{ color: '#666', fontSize: '14px' }}>今週の予定はありません</p>
              )}
            </div>

            {/* This Month Overview */}
            <div style={{ backgroundColor: '#f3e5f5', padding: '15px', borderRadius: '8px' }}>
              <h3>📊 今月のサマリー</h3>
              <div style={{ fontSize: '14px' }}>
                <p>総イベント数: {calendarEvents?.thisMonth?.length || 0}</p>
                <p>今週の予定: {calendarEvents?.thisWeek?.length || 0}</p>
                <p>今日の予定: {calendarEvents?.today?.length || 0}</p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ textAlign: 'center', marginTop: '50px' }}>
          <h2>📅 タスク管理を始めましょう</h2>
          <p>Googleカレンダーと連携して、効率的なタスク管理を実現します</p>
          <button 
            onClick={handleLogin}
            style={{
              backgroundColor: '#4285f4',
              color: 'white',
              border: 'none',
              padding: '12px 24px',
              borderRadius: '5px',
              fontSize: '16px',
              cursor: 'pointer'
            }}
          >
            Googleでログイン
          </button>
        </div>
      )}
    </div>
  );
};

export default HomePage;