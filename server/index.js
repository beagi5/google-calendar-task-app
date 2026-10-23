require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { google } = require('googleapis');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const validator = require('validator');
const crypto = require('crypto');
const notion = require('./notion');
const { completionPatch } = require('./calendar-done');

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

// Task storage: persisted to server/data/tasks.json on every mutation.
// The TASKS_FILE environment variable overrides the location (the tests use it so they never
// touch the real data; a relative path is taken from the working directory). When it is unset
// the path is the usual server/data/tasks.json.
const fs = require('fs');
const path = require('path');

const TASKS_FILE = process.env.TASKS_FILE
  ? path.resolve(process.env.TASKS_FILE)
  : path.join(__dirname, 'data', 'tasks.json');
const DATA_DIR = path.dirname(TASKS_FILE);
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

// Returns true when the file was written, false when writing failed (the error is logged, as before).
// The existing routes do not look at the result and behave as they always did; the Claude API
// answers 500 and undoes its change when this returns false.
const saveTasksToFile = () => {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(taskStorage, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Failed to save tasks.json:', err);
    return false;
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

// Allowed task categories. Omitted on create -> server defaults to 'その他'.
const VALID_CATEGORIES = ['YCDC', '事業', '株', 'マネジメント', 'その他'];

// Input validation. The rules live in plain functions (no req/res) that return an error message,
// or null when the input is fine, so the Claude API can run the very same rules per item in bulk.
const taskInputError = (body) => {
  const { title, description, level, dueDate, category, weekStart } = body;

  // Validate required fields
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return 'Valid title is required';
  }

  if (title.length > 200) {
    return 'Title too long (max 200 characters)';
  }

  if (description && description.length > 1000) {
    return 'Description too long (max 1000 characters)';
  }

  const validLevels = ['yearly', 'quarterly', 'monthly', 'weekly', 'daily'];
  if (!validLevels.includes(level)) {
    return 'Invalid task level';
  }

  if (dueDate && !validator.isISO8601(dueDate)) {
    return 'Invalid date format';
  }

  if (category !== undefined && !VALID_CATEGORIES.includes(category)) {
    return 'Invalid category';
  }

  if (weekStart !== undefined && weekStart !== null && !validator.isISO8601(weekStart)) {
    return 'Invalid weekStart format';
  }

  return null;
};

// Input validation middleware
const validateTaskInput = (req, res, next) => {
  const error = taskInputError(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  const { title, description } = req.body;

  // Trim inputs. No HTML-escaping here: React escapes text on render (no innerHTML anywhere),
  // and escaping at input stored '/' as '&#x2F;', which then showed up literally on screen and in Calendar.
  req.body.title = title.trim();
  if (description) {
    req.body.description = description.trim();
  }

  next();
};

// A new task row. Shared by POST /api/tasks and the Claude API so both create the same shape.
function buildTask({ title, description, level, parentId, dueDate, category, weekStart }, userId) {
  return {
    id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    title,
    description,
    level,
    parentId: parentId || null,
    dueDate: dueDate || null,
    category: category || 'その他',
    weekStart: weekStart || null,
    progress: 0,
    completed: false,
    repeat: 'none',
    createdAt: new Date().toISOString(),
    syncedToCalendar: false,
    userId // Associate task with user
  };
}

// Marking a task done sets progress to 100 unless the same request sets progress itself;
// un-marking leaves progress as it was. Shared by PUT /api/tasks/:id and the Claude API.
function setTaskCompleted(task, completed, progress) {
  task.completed = completed;
  if (progress === undefined) task.progress = completed ? 100 : task.progress;
}

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
    // Plain text to Google Calendar. Escaping here wrote '&#x2F;' etc. into the user's real events.
    if (summary !== undefined) resource.summary = summary.trim();
    if (description !== undefined) resource.description = (description || '').trim();
    if (location !== undefined) resource.location = (location || '').trim();

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

// Move a task's all-day calendar event to a new date (same shape as createTaskCalendarEvent)
async function patchCalendarEventDate(req, eventId, date) {
  const calendar = getCalendarClientForRequest(req);
  if (!calendar) return { ok: false };
  try {
    await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      resource: { start: { date }, end: { date } },
    });
    return { ok: true };
  } catch (err) {
    console.error('Failed to move calendar event date:', err);
    return { ok: false };
  }
}

// The "[完了] " title and the Graphite color (the rules are in calendar-done.js)
async function patchCalendarEventForCompletion(req, eventId, completed) {
  const calendar = getCalendarClientForRequest(req);
  if (!calendar) return { ok: false };
  try {
    const current = await calendar.events.get({ calendarId: 'primary', eventId });
    const resource = completionPatch(current.data, completed);
    await calendar.events.patch({ calendarId: 'primary', eventId, resource, sendUpdates: 'none' });
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
    const { level, dueDate, syncToCalendar } = req.body;

    const newTask = buildTask(req.body, req.user.id);

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
// every field is optional (a completion toggle sends only { completed }).
// Like taskInputError, the rules are a plain function so the Claude API can share them.
const taskUpdateError = (body) => {
  const { title, description, dueDate, progress, completed, parentId, syncToCalendar, category, weekStart } = body;

  if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 200)) {
    return 'Invalid title';
  }
  if (description !== undefined && description !== null && description.length > 1000) {
    return 'Description too long (max 1000 characters)';
  }
  if (dueDate !== undefined && dueDate !== null && !validator.isISO8601(dueDate)) {
    return 'Invalid date format';
  }
  if (progress !== undefined && (typeof progress !== 'number' || progress < 0 || progress > 100)) {
    return 'Invalid progress';
  }
  if (completed !== undefined && typeof completed !== 'boolean') {
    return 'Invalid completed flag';
  }
  if (parentId !== undefined && parentId !== null && typeof parentId !== 'string') {
    return 'Invalid parentId';
  }
  if (syncToCalendar !== undefined && typeof syncToCalendar !== 'boolean') {
    return 'Invalid syncToCalendar flag';
  }
  if (category !== undefined && !VALID_CATEGORIES.includes(category)) {
    return 'Invalid category';
  }
  if (weekStart !== undefined && weekStart !== null && !validator.isISO8601(weekStart)) {
    return 'Invalid weekStart format';
  }

  return null;
};

const validateTaskUpdate = (req, res, next) => {
  const error = taskUpdateError(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  const { title, description } = req.body;

  // Trim only (see validateTaskInput for why there is no HTML-escaping)
  if (title !== undefined) req.body.title = title.trim();
  if (description) req.body.description = description.trim();

  next();
};

// Carry over: move the user's overdue, incomplete daily tasks to `toDate` (the client's "today").
// Optional `taskIds` limits it to those tasks. One request instead of one PUT per task,
// because the API rate limit is tight.
app.post('/api/tasks/carry-over', requireAuth, async (req, res) => {
  const { toDate, taskIds } = req.body;
  if (typeof toDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) || !validator.isISO8601(toDate)) {
    return res.status(400).json({ error: 'toDate must be YYYY-MM-DD' });
  }
  if (taskIds !== undefined && (!Array.isArray(taskIds) || taskIds.some((id) => typeof id !== 'string'))) {
    return res.status(400).json({ error: 'taskIds must be an array of strings' });
  }

  const targets = (taskStorage.daily || []).filter((task) =>
    task.userId === req.user.id &&
    !task.completed &&
    task.dueDate &&
    task.dueDate.split('T')[0] < toDate &&
    (!taskIds || taskIds.includes(task.id))
  );

  for (const task of targets) {
    task.dueDate = toDate;
    task.carriedOverAt = new Date().toISOString();
    if (task.calendarEventId) {
      const result = await patchCalendarEventDate(req, task.calendarEventId, toDate);
      if (!result.ok) {
        task.calendarSyncError = 'Calendar update failed';
      } else {
        delete task.calendarSyncError;
      }
    }
  }
  if (targets.length > 0) saveTasksToFile();

  res.json({ moved: targets.length, tasks: targets });
});

app.put('/api/tasks/:id', requireAuth, validateTaskUpdate, async (req, res) => {
  const { id } = req.params;
  const { title, description, dueDate, progress, completed, parentId, syncToCalendar, category, weekStart } = req.body;

  // Find and update task (ensure user owns the task)
  for (let level in taskStorage) {
    const taskIndex = taskStorage[level].findIndex(task => task.id === id && task.userId === req.user.id);
    if (taskIndex === -1) continue;

    const task = taskStorage[level][taskIndex];
    const wasCompleted = task.completed;

    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (category !== undefined) task.category = category;
    if (weekStart !== undefined) task.weekStart = weekStart || null;
    if (dueDate !== undefined) {
      const dateChanged = (dueDate || null) !== task.dueDate;
      task.dueDate = dueDate || null;
      if (dateChanged && task.dueDate && task.calendarEventId) {
        const result = await patchCalendarEventDate(req, task.calendarEventId, task.dueDate.split('T')[0]);
        if (!result.ok) {
          task.calendarSyncError = 'Calendar update failed';
        } else {
          delete task.calendarSyncError;
        }
      }
    }
    if (parentId !== undefined) task.parentId = parentId || null;
    if (progress !== undefined) task.progress = progress;

    if (completed !== undefined && completed !== wasCompleted) {
      setTaskCompleted(task, completed, progress);

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

// ---------------------------------------------------------------------------
// Claude API: read and write tasks with a shared token instead of a Google login, so a Claude
// session can use it with curl (localhost on this PC, Tailscale from the other one).
//
// - Enabled only when both CLAUDE_API_TOKEN and CLAUDE_API_USER_ID are set. Otherwise every
//   /api/claude/* request is answered 503. The routes are registered either way: if they were
//   not, a GET would fall through to the SPA fallback below and come back as index.html (200).
// - Rows created here belong to CLAUDE_API_USER_ID (the owner's Google user id), so the owner can
//   still edit and delete them from the logged-in screen. Update and delete only touch rows with
//   that userId.
// - It never calls Google Calendar (there is no OAuth token on this path). A row that already has
//   a calendarEventId therefore cannot be completed, re-dated or deleted from here (409).
// - Mounted under /api, after apiLimiter, so the 50 requests / 15 min limit applies to it too.
// - The token and the Authorization header are never logged or sent back.
// - Text that went through a wrong character encoding arrives as U+FFFD (Git's curl sends Japanese
//   typed inline after -d as Shift-JIS, for one). A title or description containing it is refused
//   with 400 here, instead of being saved garbled. Only here: the shared rules, and so
//   /api/tasks, are left as they were.
// - A write and the file go together: if saving fails, the change is undone in memory and the
//   answer is 500 "Failed to save tasks", so the memory never gets ahead of the file.
// ---------------------------------------------------------------------------
// Surrounding whitespace in the settings is ignored: a stray space must not silently break the
// token match, or give new rows an owner id that the logged-in screen does not recognise.
const CLAUDE_API_TOKEN = (process.env.CLAUDE_API_TOKEN || '').trim();
const CLAUDE_API_USER_ID = (process.env.CLAUDE_API_USER_ID || '').trim();
const CLAUDE_API_ENABLED = CLAUDE_API_TOKEN !== '' && CLAUDE_API_USER_ID !== '';
const CLAUDE_BULK_MAX = 200;

// Both sides are hashed so timingSafeEqual always gets buffers of the same length: it throws when
// the lengths differ, and checking the lengths first would leak the length of the real token.
const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();
const CLAUDE_API_TOKEN_HASH = sha256(CLAUDE_API_TOKEN);

const hasValidClaudeToken = (req) => {
  const header = req.get('Authorization');
  const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header) : null;
  if (!match) return false;
  return crypto.timingSafeEqual(sha256(match[1]), CLAUDE_API_TOKEN_HASH);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The shared rules call .length / .trim() / validator.isISO8601 on these fields, which throw
// (500) on non-strings, and a bulk item can be any JSON value. Check the shape first so the
// Claude API answers 400 instead.
const claudeShapeError = (value, what) => {
  if (!isPlainObject(value)) return `${what} must be a JSON object`;
  for (const key of ['description', 'dueDate', 'weekStart', 'parentId']) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') {
      return `Invalid ${key}`;
    }
  }
  return null;
};

const CLAUDE_BODY = 'Request body (Content-Type: application/json)';

// U+FFFD, the replacement character that a body in the wrong encoding is decoded into.
const REPLACEMENT_CHAR = String.fromCodePoint(0xFFFD);

// Refuses a title or description that contains it. Needs a plain object (see claudeShapeError).
const claudeTextError = (value) => {
  for (const key of ['title', 'description']) {
    if (typeof value[key] === 'string' && value[key].includes(REPLACEMENT_CHAR)) {
      return 'Text contains U+FFFD; send the body as UTF-8';
    }
  }
  return null;
};

// One new-task body checked with the POST /api/tasks rules (plus the Claude API's own checks above).
// Returns { error } or { input } (a trimmed copy). Fields the rules do not know (userId,
// calendarEventId, ...) are never used.
const claudeNewTask = (raw, what) => {
  const error = claudeShapeError(raw, what) || claudeTextError(raw) || taskInputError(raw);
  if (error) return { error };
  const input = { ...raw, title: raw.title.trim() };
  if (raw.description) input.description = raw.description.trim();
  return { input };
};

// Adds the rows to the end of their level arrays (making an array that is missing). Returns the
// function that takes exactly these rows, and the arrays this call made, out again.
const appendTasks = (tasks) => {
  const madeLevels = [];
  for (const task of tasks) {
    if (!taskStorage[task.level]) {
      taskStorage[task.level] = [];
      madeLevels.push(task.level);
    }
    taskStorage[task.level].push(task);
  }
  return () => {
    for (const task of tasks) {
      const rows = taskStorage[task.level];
      const index = rows.lastIndexOf(task);
      if (index !== -1) rows.splice(index, 1);
    }
    for (const level of madeLevels) delete taskStorage[level];
  };
};

// Saves after an in-memory change. If the file cannot be written, `undo` puts the memory back (in
// place, so the file and the memory never differ), the answer is 500, and this returns false: the
// caller must stop. Returns true when the caller may answer 200.
const saveOrUndo = (res, undo) => {
  if (saveTasksToFile()) return true;
  undo();
  res.status(500).json({ error: 'Failed to save tasks' });
  return false;
};

// The row with this id, but only if it belongs to CLAUDE_API_USER_ID.
const findClaudeTask = (id) => {
  for (const level of Object.keys(taskStorage)) {
    if (!Array.isArray(taskStorage[level])) continue;
    const index = taskStorage[level].findIndex((task) => task.id === id && task.userId === CLAUDE_API_USER_ID);
    if (index !== -1) return { level, index, task: taskStorage[level][index] };
  }
  return null;
};

const claudeApi = express.Router();

claudeApi.use((req, res, next) => {
  if (!CLAUDE_API_ENABLED) {
    return res.status(503).json({ error: 'Claude API is disabled' });
  }
  if (!hasValidClaudeToken(req)) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  next();
});

claudeApi.get('/tasks', (req, res) => {
  res.json(taskStorage);
});

claudeApi.post('/tasks', (req, res) => {
  const { error, input } = claudeNewTask(req.body, CLAUDE_BODY);
  if (error) return res.status(400).json({ error });

  const task = buildTask(input, CLAUDE_API_USER_ID);
  const undo = appendTasks([task]);
  if (!saveOrUndo(res, undo)) return;
  res.json(task);
});

// 1 to CLAUDE_BULK_MAX tasks at once. Every item is validated before anything is created, so one
// bad item means no item is created. The rows are appended in the order sent, with a single save.
claudeApi.post('/tasks/bulk', (req, res) => {
  if (!isPlainObject(req.body) || !Array.isArray(req.body.tasks)) {
    return res.status(400).json({ error: `${CLAUDE_BODY} must be {"tasks":[...]}` });
  }
  const items = req.body.tasks;
  if (items.length < 1 || items.length > CLAUDE_BULK_MAX) {
    return res.status(400).json({ error: `tasks must contain 1 to ${CLAUDE_BULK_MAX} items` });
  }

  const tasks = [];
  for (let index = 0; index < items.length; index++) {
    const { error, input } = claudeNewTask(items[index], 'Task');
    if (error) return res.status(400).json({ error, index });
    tasks.push(buildTask(input, CLAUDE_API_USER_ID));
  }

  const undo = appendTasks(tasks);
  if (!saveOrUndo(res, undo)) return;
  res.json({ created: tasks });
});

claudeApi.put('/tasks/:id', (req, res) => {
  const body = req.body;
  const badInput = claudeShapeError(body, CLAUDE_BODY) || claudeTextError(body);
  if (badInput) return res.status(400).json({ error: badInput });
  // Silently ignoring it would let the caller believe the calendar was updated.
  if (Object.prototype.hasOwnProperty.call(body, 'syncToCalendar')) {
    return res.status(400).json({ error: 'syncToCalendar is not supported by the Claude API' });
  }
  const invalid = taskUpdateError(body);
  if (invalid) return res.status(400).json({ error: invalid });

  const found = findClaudeTask(req.params.id);
  if (!found) return res.status(404).json({ error: 'Task not found' });
  const { task } = found;

  const { title, description, dueDate, progress, completed, parentId, category, weekStart } = body;
  const completionChanges = completed !== undefined && completed !== task.completed;
  const dueDateChanges = dueDate !== undefined && (dueDate || null) !== task.dueDate;

  // Without OAuth the calendar event cannot follow, so refuse (and change nothing) rather than
  // leave the task and its event out of step. Re-sending the current values is not a change.
  if (task.calendarEventId && (completionChanges || dueDateChanges)) {
    return res.status(409).json({
      error: 'Task is linked to a Google Calendar event: completed and dueDate cannot be changed with the Claude API'
    });
  }

  // The row as it is now, to put back (in the same key order) if the file cannot be saved.
  const before = { ...task };
  const undo = () => {
    for (const key of Object.keys(task)) delete task[key];
    Object.assign(task, before);
  };

  if (title !== undefined) task.title = title.trim();
  if (description !== undefined) task.description = description ? description.trim() : description;
  if (category !== undefined) task.category = category;
  if (weekStart !== undefined) task.weekStart = weekStart || null;
  if (dueDate !== undefined) task.dueDate = dueDate || null;
  if (parentId !== undefined) task.parentId = parentId || null;
  if (progress !== undefined) task.progress = progress;
  if (completionChanges) setTaskCompleted(task, completed, progress);

  if (!saveOrUndo(res, undo)) return;
  res.json(task);
});

claudeApi.delete('/tasks/:id', (req, res) => {
  const found = findClaudeTask(req.params.id);
  if (!found) return res.status(404).json({ error: 'Task not found' });
  if (found.task.calendarEventId) {
    return res.status(409).json({
      error: 'Task is linked to a Google Calendar event: delete it in the app so the event is removed too'
    });
  }

  const { level, index, task } = found;
  taskStorage[level].splice(index, 1);
  // If the file cannot be saved the row goes back to the position it was in.
  if (!saveOrUndo(res, () => taskStorage[level].splice(index, 0, task))) return;
  res.json(task);
});

// Any other path or method: answer in JSON here, otherwise a GET would reach the SPA fallback.
claudeApi.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use('/api/claude', claudeApi);

// ---------------------------------------------------------------------------
// Notion DB "やること": the screen's "やること（Notion）" card reads the 1-hour rows here and
// writes the "済" checkbox back (the logic is in notion.js).
//
// - Enabled only when both NOTION_TOKEN and NOTION_YARUKOTO_DATA_SOURCE_ID are set (surrounding
//   whitespace is ignored). Otherwise both routes answer 503. The routes are registered either way:
//   if they were not, a GET would fall through to the SPA fallback below and come back as index.html (200).
//   Optional: NOTION_API_BASE (default https://api.notion.com, for tests) and NOTION_VERSION (default 2026-03-11).
// - requireAuth (Google login) is in front of both, and they sit under /api, so apiLimiter applies.
// - The token stays on the server: it is never sent to the browser, logged or put in a response.
// ---------------------------------------------------------------------------
const yarukoto = notion.createYarukotoFromEnv(process.env);
const yarukotoRoutes = notion.createRoutes(yarukoto);

app.get('/api/yarukoto', requireAuth, yarukotoRoutes.list);
app.patch('/api/yarukoto/:pageId', requireAuth, yarukotoRoutes.update);

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
  console.log(CLAUDE_API_ENABLED ? 'Claude API: enabled' : 'Claude API: disabled (token or owner id not set)');
  console.log(yarukoto ? 'Notion yarukoto: enabled' : 'Notion yarukoto: disabled (token or data source id not set)');
});