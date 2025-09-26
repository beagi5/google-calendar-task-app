require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { google } = require('googleapis');

// In-memory task storage (in production, this would be a database)
let taskStorage = {
  yearly: [
    { id: 'y1', title: '2025年：キャリア成長', description: 'プロジェクトマネジメントスキルの向上', progress: 25, createdAt: new Date().toISOString() }
  ],
  quarterly: [
    { id: 'q1', title: 'Q3 2025：新技術習得', description: 'React/Node.jsの深い理解', parentId: 'y1', progress: 40, createdAt: new Date().toISOString() }
  ],
  monthly: [
    { id: 'm1', title: '9月：タスク管理アプリ完成', description: 'Googleカレンダー連携機能実装', parentId: 'q1', progress: 60, createdAt: new Date().toISOString() }
  ],
  weekly: [
    { id: 'w1', title: '今週：基本機能実装', description: 'カレンダー表示とタスク管理', parentId: 'm1', progress: 70, createdAt: new Date().toISOString() }
  ],
  daily: [
    { id: 'd1', title: '今日：タスク作成機能実装', description: 'フォームとAPI連携', parentId: 'w1', progress: 80, dueDate: new Date().toISOString(), createdAt: new Date().toISOString() }
  ]
};

// Passport configuration
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback"
  },
  function(accessToken, refreshToken, profile, cb) {
    return cb(null, { profile: profile, accessToken: accessToken, refreshToken: refreshToken });
  }
));

passport.serializeUser(function(user, cb) {
  cb(null, user);
});

passport.deserializeUser(function(obj, cb) {
  cb(null, obj);
});

const app = express();

// Middleware
app.use(cors({
  origin: 'http://localhost:3000', // Allow requests from the React app
  credentials: true
}));
app.use(express.json()); // Add JSON parsing middleware
app.use(session({
  secret: 'your_secret_key', // Replace with a real secret key in production
  resave: false,
  saveUninitialized: true,
}));
app.use(passport.initialize());
app.use(passport.session());

// Auth routes
app.get('/auth/google',
  passport.authenticate('google', { scope: [
    'profile', 
    'email', 
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events'
  ] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: 'http://localhost:3000/login' }),
  function(req, res) {
    res.redirect('http://localhost:3000/');
  });

// A simple test route to check if the user is authenticated
app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json(req.user);
  } else {
    res.status(401).json({ message: 'Not authenticated' });
  }
});

// Google Calendar API routes
app.get('/api/calendar/events', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'http://localhost:3001/auth/google/callback'
    );

    oauth2Client.setCredentials({
      access_token: req.user.accessToken,
      refresh_token: req.user.refreshToken
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // Get events for today, this week, and this month
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfMonth.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];
    
    // Categorize events by time period
    const today = new Date();
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);

    const categorizedEvents = {
      today: [],
      thisWeek: [],
      thisMonth: []
    };

    events.forEach(event => {
      const eventDate = new Date(event.start.dateTime || event.start.date);
      const eventDateOnly = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());
      const todayDateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());

      if (eventDateOnly.getTime() === todayDateOnly.getTime()) {
        categorizedEvents.today.push(event);
      }
      
      if (eventDate >= startOfWeek && eventDate <= endOfWeek) {
        categorizedEvents.thisWeek.push(event);
      }
      
      categorizedEvents.thisMonth.push(event);
    });

    res.json(categorizedEvents);
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    res.status(500).json({ message: 'Error fetching calendar events' });
  }
});

// Task management API routes
app.get('/api/tasks', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  
  res.json(taskStorage);
});

app.post('/api/tasks', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  
  const { title, description, level, parentId, dueDate } = req.body;
  
  // Create new task
  const newTask = {
    id: 'task_' + Date.now(),
    title,
    description,
    level,
    parentId: parentId || null,
    dueDate: dueDate || null,
    progress: 0,
    createdAt: new Date().toISOString()
  };
  
  // Add to appropriate level in storage
  if (!taskStorage[level]) {
    taskStorage[level] = [];
  }
  taskStorage[level].push(newTask);
  
  console.log('New task created:', newTask);
  res.json(newTask);
});

// Update task progress
app.put('/api/tasks/:id', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  
  const { id } = req.params;
  const { progress, title, description } = req.body;
  
  // Find and update task
  for (let level in taskStorage) {
    const taskIndex = taskStorage[level].findIndex(task => task.id === id);
    if (taskIndex !== -1) {
      if (progress !== undefined) taskStorage[level][taskIndex].progress = progress;
      if (title !== undefined) taskStorage[level][taskIndex].title = title;
      if (description !== undefined) taskStorage[level][taskIndex].description = description;
      
      return res.json(taskStorage[level][taskIndex]);
    }
  }
  
  res.status(404).json({ message: 'Task not found' });
});

// Delete task
app.delete('/api/tasks/:id', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  
  const { id } = req.params;
  
  // Find and delete task
  for (let level in taskStorage) {
    const taskIndex = taskStorage[level].findIndex(task => task.id === id);
    if (taskIndex !== -1) {
      const deletedTask = taskStorage[level].splice(taskIndex, 1)[0];
      return res.json(deletedTask);
    }
  }
  
  res.status(404).json({ message: 'Task not found' });
});

// Logout route
app.get('/logout', (req, res, next) => {
  req.logout(function(err) {
    if (err) { return next(err); }
    res.redirect('http://localhost:3000/');
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});