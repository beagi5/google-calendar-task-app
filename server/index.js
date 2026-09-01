require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { google } = require('googleapis');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const validator = require('validator');

// Security middleware setup
const app = express();

// Basic security headers
// hsts: false — this app is intentionally served over plain HTTP (Tailscale private network,
// no TLS cert for the Tailscale hostname). HSTS would make browsers force-upgrade to HTTPS
// and fail to connect at all.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      upgradeInsecureRequests: null // this app is intentionally HTTP-only (Tailscale); don't force-upgrade sub-resources to HTTPS
    }
  },
  hsts: false
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Stricter rate limit for API endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Too many API requests, please try again later.'
});

// Task storage: persisted to server/data/tasks.json on every mutation
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let taskStorage = {
  yearly: [],
  quarterly: [],
  monthly: [],
  weekly: [],
  daily: []
};
try {
  taskStorage = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
} catch (err) {
  console.warn('tasks.json not found or invalid — starting empty.', err.message);
}

const saveTasksToFile = () => {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(taskStorage, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save tasks.json:', err);
  }
};

// Secure session configuration
const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'your-super-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true', // HTTPS only when explicitly enabled
    httpOnly: true, // Prevent XSS
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
};

// Passport configuration
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || "http://localhost:3001/auth/google/callback",
    passReqToCallback: false
  },
  async function(accessToken, refreshToken, profile, done) {
    const user = {
      id: profile.id,
      profile: {
        displayName: profile.displayName,
        photos: profile.photos
      },
      tokens: {
        accessToken,
        refreshToken
      }
    };
    return done(null, user);
  }
));

passport.serializeUser((user, done) => {
  // Only serialize user ID, not the full user object
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  // In production, retrieve from secure database
  // For now, we'll need to implement a user store
  done(null, { id });
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(session(sessionConfig));
app.use(passport.initialize());
app.use(passport.session());

// Serve the React production build (npm run build)
const BUILD_DIR = path.join(__dirname, '..', 'build');
app.use(express.static(BUILD_DIR));

// Input validation middleware
const validateTaskInput = (req, res, next) => {
  const { title, description, level, dueDate } = req.body;
  
  // Validate required fields
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({ error: 'Valid title is required' });
  }
  
  if (title.length > 200) {
    return res.status(400).json({ error: 'Title too long (max 200 characters)' });
  }
  
  if (description && description.length > 1000) {
    return res.status(400).json({ error: 'Description too long (max 1000 characters)' });
  }
  
  const validLevels = ['yearly', 'quarterly', 'monthly', 'weekly', 'daily'];
  if (!validLevels.includes(level)) {
    return res.status(400).json({ error: 'Invalid task level' });
  }
  
  if (dueDate && !validator.isISO8601(dueDate)) {
    return res.status(400).json({ error: 'Invalid date format' });
  }
  
  // Sanitize inputs
  req.body.title = validator.escape(title.trim());
  if (description) {
    req.body.description = validator.escape(description.trim());
  }
  
  next();
};

// Authentication middleware
const requireAuth = (req, res, next) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

// Enhanced user retrieval for tokens
const getUserWithTokens = async (userId) => {
  // In production, retrieve from encrypted database
  // For demo, using session storage (not recommended for production)
  return req.session.userTokens;
};

// Auth routes
app.get('/auth/google',
  passport.authenticate('google', { 
    scope: [
      'profile', 
      'email', 
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events'
    ] 
  }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=auth_failed' }),
  function(req, res) {
    // Store tokens securely in session (encrypted in production)
    req.session.userTokens = req.user.tokens;
    res.redirect('/');
  });

// Secure API routes with rate limiting
app.use('/api', apiLimiter);

app.get('/api/user', requireAuth, (req, res) => {
  // Return only safe user data, never tokens
  res.json({
    id: req.user.id,
    profile: {
      displayName: req.user.profile?.displayName || 'User',
      photos: req.user.profile?.photos || []
    }
  });
});

app.get('/api/calendar/events', requireAuth, async (req, res) => {
  try {
    const userTokens = req.session.userTokens;
    if (!userTokens || !userTokens.accessToken) {
      return res.status(401).json({ error: 'Calendar access not authorized' });
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      '/auth/google/callback'
    );

    oauth2Client.setCredentials({
      access_token: userTokens.accessToken,
      refresh_token: userTokens.refreshToken
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // Get events with error handling for token refresh
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59);

    let response;
    try {
      response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: startOfDay.toISOString(),
        timeMax: endOfNextMonth.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250 // Limit results
      });
    } catch (error) {
      if (error.code === 401) {
        // Token might be expired, attempt refresh
        if (userTokens.refreshToken) {
          try {
            const { credentials } = await oauth2Client.refreshAccessToken();
            oauth2Client.setCredentials(credentials);
            req.session.userTokens.accessToken = credentials.access_token;
            
            response = await calendar.events.list({
              calendarId: 'primary',
              timeMin: startOfDay.toISOString(),
              timeMax: endOfNextMonth.toISOString(),
              singleEvents: true,
              orderBy: 'startTime',
              maxResults: 250
            });
          } catch (refreshError) {
            return res.status(401).json({ error: 'Calendar access expired. Please re-authenticate.' });
          }
        } else {
          return res.status(401).json({ error: 'Calendar access expired. Please re-authenticate.' });
        }
      } else {
        throw error;
      }
    }

    const events = response.data.items || [];
    
    // Categorize events by time period
    const today = new Date();
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    
    const startOfNextWeek = new Date(endOfWeek);
    startOfNextWeek.setDate(endOfWeek.getDate() + 1);
    const endOfNextWeek = new Date(startOfNextWeek);
    endOfNextWeek.setDate(startOfNextWeek.getDate() + 6);
    
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const endOfNextMonthCalc = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59);

    const categorizedEvents = {
      today: [],
      thisWeek: [],
      thisMonth: [],
      nextWeek: [],
      nextMonth: []
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
      
      if (eventDate.getMonth() === today.getMonth() && eventDate.getFullYear() === today.getFullYear()) {
        categorizedEvents.thisMonth.push(event);
      }
      
      if (eventDate >= startOfNextWeek && eventDate <= endOfNextWeek) {
        categorizedEvents.nextWeek.push(event);
      }
      
      if (eventDate >= startOfNextMonth && eventDate <= endOfNextMonthCalc) {
        categorizedEvents.nextMonth.push(event);
      }
    });

    res.json(categorizedEvents);
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

app.patch('/api/calendar/events/:eventId', requireAuth, async (req, res) => {
  try {
    const calendar = getCalendarClientForRequest(req);
    if (!calendar) return res.status(401).json({ error: 'Calendar access not authorized' });

    const { summary, description, location, date, allDay, startTime, endTime } = req.body;

    if (summary !== undefined && (typeof summary !== 'string' || !summary.trim())) {
      return res.status(400).json({ error: 'Valid summary is required' });
    }
    if (date !== undefined && !validator.isISO8601(date)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    const resource = {};
    if (summary !== undefined) resource.summary = validator.escape(summary.trim());
    if (description !== undefined) resource.description = validator.escape((description || '').trim());
    if (location !== undefined) resource.location = validator.escape((location || '').trim());

    if (date) {
      if (allDay) {
        resource.start = { date };
        resource.end = { date };
      } else {
        const start = startTime || '00:00';
        const end = endTime || start;
        resource.start = { dateTime: `${date}T${start}:00`, timeZone: 'Asia/Tokyo' };
        resource.end = { dateTime: `${date}T${end}:00`, timeZone: 'Asia/Tokyo' };
      }
    }

    const response = await calendar.events.patch({
      calendarId: 'primary',
      eventId: req.params.eventId,
      resource,
    });

    res.json(response.data);
  } catch (error) {
    console.error('Failed to update calendar event:', error);
    res.status(500).json({ error: 'Failed to update calendar event' });
  }
});

app.patch('/api/calendar/events/:eventId/complete', requireAuth, async (req, res) => {
  const { completed } = req.body;
  if (typeof completed !== 'boolean') {
    return res.status(400).json({ error: 'completed must be boolean' });
  }
  const result = await patchCalendarEventForCompletion(req, req.params.eventId, completed);
  if (!result.ok) {
    return res.status(500).json({ error: 'Failed to update event completion' });
  }
  res.json({ success: true });
});

app.delete('/api/calendar/events/:eventId', requireAuth, async (req, res) => {
  try {
    const calendar = getCalendarClientForRequest(req);
    if (!calendar) return res.status(401).json({ error: 'Calendar access not authorized' });

    await calendar.events.delete({ calendarId: 'primary', eventId: req.params.eventId });
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete calendar event:', error);
    res.status(500).json({ error: 'Failed to delete calendar event' });
  }
});

// Shared calendar helpers (used by task create, complete, and delete)
function getCalendarClientForRequest(req) {
  const userTokens = req.session.userTokens;
  if (!userTokens || !userTokens.accessToken) return null;
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    '/auth/google/callback'
  );
  oauth2Client.setCredentials({
    access_token: userTokens.accessToken,
    refresh_token: userTokens.refreshToken
  });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

async function createTaskCalendarEvent(req, task) {
  try {
    const calendar = getCalendarClientForRequest(req);
    if (!calendar) return;

    const eventData = {
      summary: `[タスク] ${task.title}`,
      description: `${task.description || ''}\n\nレベル: ${task.level}\n作成日: ${new Date().toLocaleDateString('ja-JP')}`,
      start: { date: task.dueDate.split('T')[0] },
      end: { date: task.dueDate.split('T')[0] },
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: eventData,
    });

    task.syncedToCalendar = true;
    task.calendarEventId = response.data.id;
  } catch (err) {
    console.error('Calendar sync failed:', err);
    task.calendarSyncError = 'Calendar sync failed';
  }
}

const COMPLETED_PREFIX = '[完了] ';

async function patchCalendarEventForCompletion(req, eventId, completed) {
  const calendar = getCalendarClientForRequest(req);
  if (!calendar) return { ok: false };
  try {
    const current = await calendar.events.get({ calendarId: 'primary', eventId });
    let summary = current.data.summary || '';
    if (completed && !summary.startsWith(COMPLETED_PREFIX)) summary = COMPLETED_PREFIX + summary;
    if (!completed && summary.startsWith(COMPLETED_PREFIX)) summary = summary.slice(COMPLETED_PREFIX.length);
    await calendar.events.patch({ calendarId: 'primary', eventId, resource: { summary } });
    return { ok: true };
  } catch (err) {
    console.error('Failed to patch calendar event completion state:', err);
    return { ok: false };
  }
}

app.get('/api/tasks', requireAuth, (req, res) => {
  res.json(taskStorage);
});

app.post('/api/tasks', requireAuth, validateTaskInput, async (req, res) => {
  try {
    const { title, description, level, parentId, dueDate, syncToCalendar } = req.body;

    const newTask = {
      id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      title,
      description,
      level,
      parentId: parentId || null,
      dueDate: dueDate || null,
      progress: 0,
      completed: false,
      repeat: 'none',
      createdAt: new Date().toISOString(),
      syncedToCalendar: false,
      userId: req.user.id // Associate task with user
    };

    // Add to storage
    if (!taskStorage[level]) {
      taskStorage[level] = [];
    }
    taskStorage[level].push(newTask);
    saveTasksToFile();

    // Sync to calendar if requested and user has calendar access
    if (syncToCalendar && dueDate) {
      await createTaskCalendarEvent(req, newTask);
      saveTasksToFile();
    }

    res.json(newTask);
  } catch (error) {
    console.error('Task creation error:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// Lightweight partial-update validator for PUT — unlike validateTaskInput,
// every field is optional (a completion toggle sends only { completed })
const validateTaskUpdate = (req, res, next) => {
  const { title, description, dueDate, progress, completed, parentId, syncToCalendar } = req.body;

  if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 200)) {
    return res.status(400).json({ error: 'Invalid title' });
  }
  if (description !== undefined && description !== null && description.length > 1000) {
    return res.status(400).json({ error: 'Description too long (max 1000 characters)' });
  }
  if (dueDate !== undefined && dueDate !== null && !validator.isISO8601(dueDate)) {
    return res.status(400).json({ error: 'Invalid date format' });
  }
  if (progress !== undefined && (typeof progress !== 'number' || progress < 0 || progress > 100)) {
    return res.status(400).json({ error: 'Invalid progress' });
  }
  if (completed !== undefined && typeof completed !== 'boolean') {
    return res.status(400).json({ error: 'Invalid completed flag' });
  }
  if (parentId !== undefined && parentId !== null && typeof parentId !== 'string') {
    return res.status(400).json({ error: 'Invalid parentId' });
  }
  if (syncToCalendar !== undefined && typeof syncToCalendar !== 'boolean') {
    return res.status(400).json({ error: 'Invalid syncToCalendar flag' });
  }

  if (title !== undefined) req.body.title = validator.escape(title.trim());
  if (description) req.body.description = validator.escape(description.trim());

  next();
};

app.put('/api/tasks/:id', requireAuth, validateTaskUpdate, async (req, res) => {
  const { id } = req.params;
  const { title, description, dueDate, progress, completed, parentId, syncToCalendar } = req.body;

  // Find and update task (ensure user owns the task)
  for (let level in taskStorage) {
    const taskIndex = taskStorage[level].findIndex(task => task.id === id && task.userId === req.user.id);
    if (taskIndex === -1) continue;

    const task = taskStorage[level][taskIndex];
    const wasCompleted = task.completed;

    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (dueDate !== undefined) task.dueDate = dueDate || null;
    if (parentId !== undefined) task.parentId = parentId || null;
    if (progress !== undefined) task.progress = progress;

    if (completed !== undefined && completed !== wasCompleted) {
      task.completed = completed;
      if (progress === undefined) task.progress = completed ? 100 : task.progress;

      if (task.calendarEventId) {
        const result = await patchCalendarEventForCompletion(req, task.calendarEventId, completed);
        if (!result.ok) {
          task.calendarSyncError = 'Calendar update failed';
        } else {
          delete task.calendarSyncError;
        }
      }
    }

    if (syncToCalendar !== undefined && syncToCalendar !== !!task.calendarEventId) {
      if (syncToCalendar) {
        if (task.dueDate) {
          await createTaskCalendarEvent(req, task);
        }
      } else if (task.calendarEventId) {
        try {
          const calendar = getCalendarClientForRequest(req);
          if (calendar) {
            await calendar.events.delete({ calendarId: 'primary', eventId: task.calendarEventId });
          }
        } catch (err) {
          console.error('Failed to remove calendar event on unsync:', err);
        }
        task.calendarEventId = null;
        task.syncedToCalendar = false;
      }
    }

    saveTasksToFile();
    return res.json(task);
  }

  res.status(404).json({ error: 'Task not found or access denied' });
});

app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  
  // Find and delete task (ensure user owns the task)
  for (let level in taskStorage) {
    const taskIndex = taskStorage[level].findIndex(task => task.id === id && task.userId === req.user.id);
    if (taskIndex !== -1) {
      const deletedTask = taskStorage[level].splice(taskIndex, 1)[0];
      saveTasksToFile();

      // Also delete from calendar if synced
      if (deletedTask.calendarEventId) {
        try {
          const calendar = getCalendarClientForRequest(req);
          if (calendar) {
            await calendar.events.delete({
              calendarId: 'primary',
              eventId: deletedTask.calendarEventId
            });
          }
        } catch (error) {
          console.error('Failed to delete calendar event:', error);
        }
      }
      
      return res.json(deletedTask);
    }
  }
  
  res.status(404).json({ error: 'Task not found or access denied' });
});

app.get('/logout', requireAuth, (req, res, next) => {
  req.logout(function(err) {
    if (err) { return next(err); }
    req.session.destroy((err) => {
      if (err) {
        console.error('Session destruction error:', err);
      }
      res.clearCookie('connect.sid');
      res.redirect('/');
    });
  });
});

// Serve the React production build, with a SPA fallback for client-side routes
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(BUILD_DIR, 'index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Secure server running on port ${PORT}`);
});