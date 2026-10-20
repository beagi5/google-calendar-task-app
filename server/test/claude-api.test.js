'use strict';

/*
 * Tests for the token-authenticated Claude API (/api/claude/*) in server/index.js.
 * Run with: cd server && npm test   (node --test; no extra dependencies)
 *
 * How it works
 * - Each describe() block starts its own copy of the server as a child process on a free port,
 *   with TASKS_FILE pointing at a throw-away file in the OS temp dir and dummy Google OAuth values.
 *   The real server/data/tasks.json is never read or written.
 * - Several servers instead of one because apiLimiter (50 requests / 15 min per IP) must stay as
 *   it is. Every group stays well below that budget; the last group checks the limit itself.
 * - Requests are made with the built-in fetch. Tests tagged [#1]..[#15] are the required ones.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(SERVER_DIR, 'index.js');
const TEMP_PREFIX = 'claude-api-test-';

const TOKEN = 'test-token-' + crypto.randomBytes(16).toString('hex');
const OWNER_ID = 'claude-test-owner';
const OTHER_ID = 'someone-else';
const LEVELS = ['yearly', 'quarterly', 'monthly', 'weekly', 'daily'];

// ---------------------------------------------------------------------------
// Server helpers
// ---------------------------------------------------------------------------

const running = new Set();

// Safety nets so a failing run never leaves a server process behind.
process.on('exit', () => {
  for (const server of running) server.child.kill();
});
after(() => Promise.all([...running].map((server) => server.stop())));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Only ever removes a directory this file created itself with mkdtemp in the OS temp dir.
function removeOwnTempDir(dir) {
  const isOwn =
    path.resolve(path.dirname(dir)) === path.resolve(os.tmpdir()) &&
    path.basename(dir).startsWith(TEMP_PREFIX);
  if (!isOwn) return;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Starts the server with the given Claude API settings. Pass a seed (the tasks.json content) to
 * start with existing rows. Settings left out are passed as empty strings on purpose: dotenv never
 * overrides a variable that already exists, so a token in server/.env cannot leak into a test.
 */
async function startServer({ token = '', ownerId = '', seed } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const tasksFile = path.join(tmpDir, 'tasks.json');
  if (seed) fs.writeFileSync(tasksFile, JSON.stringify(seed, null, 2), 'utf8');
  const port = await getFreePort();

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // set by the test runner for test files, not meant for the server
  Object.assign(env, {
    PORT: String(port),
    TASKS_FILE: tasksFile,
    GOOGLE_CLIENT_ID: 'dummy-client-id',
    GOOGLE_CLIENT_SECRET: 'dummy-client-secret',
    CLAUDE_API_TOKEN: token,
    CLAUDE_API_USER_ID: ownerId,
  });

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output += chunk;
    });
  }

  const server = {
    port,
    tasksFile,
    child,
    output: () => output,
    async stop() {
      running.delete(server);
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => {
          child.once('exit', resolve);
          child.kill();
        });
      }
      removeOwnTempDir(tmpDir);
    },
  };
  running.add(server);

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`server did not start within 90s. Output:\n${output}`)),
        90000
      );
      child.stdout.on('data', () => {
        if (output.includes('Secure server running')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited early (code ${code}). Output:\n${output}`));
      });
    });
  } catch (err) {
    await server.stop();
    throw err;
  }
  return server;
}

/**
 * One HTTP call. `token` adds "Authorization: Bearer <token>". `body` is sent as JSON, unless it is
 * a string or a Buffer, which go out exactly as given (Content-Type defaults to application/json).
 */
async function call(server, method, route, { token, headers, body } = {}) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(15000) };
  if (token !== undefined) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
    init.body = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${server.port}${route}`, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** A call carrying the right Claude token. */
const claude = (server, method, route, body) => call(server, method, route, { token: TOKEN, body });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

const emptyStorage = () => ({ yearly: [], quarterly: [], monthly: [], weekly: [], daily: [] });

/** What is on disk. Before the first save there is no file, which counts as empty. */
function readTasksFile(server) {
  if (!fs.existsSync(server.tasksFile)) return emptyStorage();
  return JSON.parse(fs.readFileSync(server.tasksFile, 'utf8'));
}
const allRows = (data) => LEVELS.flatMap((level) => data[level] || []);
const countRows = (data) => allRows(data).length;
const findRow = (data, id) => allRows(data).find((task) => task.id === id);

/** A body for POST /api/claude/tasks: a weekly task with a category and a week, no due date. */
const weeklyBody = (overrides = {}) => ({
  title: 'weekly task',
  level: 'weekly',
  category: 'YCDC',
  weekStart: '2026-10-19',
  ...overrides,
});

/** A row as it sits in tasks.json. */
const seedRow = (overrides) => ({
  id: 'task_seed',
  title: 'seed',
  description: '',
  level: 'weekly',
  parentId: null,
  dueDate: null,
  category: 'その他',
  weekStart: '2026-10-19',
  progress: 0,
  completed: false,
  repeat: 'none',
  createdAt: '2026-10-01T00:00:00.000Z',
  syncedToCalendar: false,
  userId: OWNER_ID,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Disabled: needs both CLAUDE_API_TOKEN and CLAUDE_API_USER_ID
// ---------------------------------------------------------------------------

describe('Claude API is disabled unless both the token and the owner id are set', () => {
  let none;
  let tokenOnly;
  let ownerOnly;

  before(async () => {
    [none, tokenOnly, ownerOnly] = await Promise.all([
      startServer(),
      startServer({ token: TOKEN }),
      startServer({ ownerId: OWNER_ID }),
    ]);
  });
  after(() => Promise.all([none, tokenOnly, ownerOnly].filter(Boolean).map((server) => server.stop())));

  it('[#1] token not set: GET /api/claude/tasks is 503, as JSON (not the SPA page)', async () => {
    const res = await call(none, 'GET', '/api/claude/tasks');
    assert.equal(res.status, 503);
    assert.deepEqual(res.json, { error: 'Claude API is disabled' });
    assert.match(res.headers.get('content-type'), /application\/json/);
  });

  it('every method and path under /api/claude/ is 503, whatever the request carries', async () => {
    const requests = [
      ['GET', '/api/claude/tasks', undefined],
      ['POST', '/api/claude/tasks', weeklyBody()],
      ['POST', '/api/claude/tasks/bulk', { tasks: [weeklyBody()] }],
      ['PUT', '/api/claude/tasks/task_x', { title: 'x' }],
      ['DELETE', '/api/claude/tasks/task_x', undefined],
      ['GET', '/api/claude/no-such-path', undefined],
    ];
    for (const [method, route, body] of requests) {
      const withToken = await call(none, method, route, { token: TOKEN, body });
      assert.equal(withToken.status, 503, `${method} ${route} with a token`);
      const withEmptyToken = await call(none, method, route, { headers: { Authorization: 'Bearer ' }, body });
      assert.equal(withEmptyToken.status, 503, `${method} ${route} with an empty token`);
      const bare = await call(none, method, route, { body });
      assert.equal(bare.status, 503, `${method} ${route} without Authorization`);
    }
    assert.ok(!fs.existsSync(none.tasksFile), 'a disabled API must not write anything');
  });

  it('a token without an owner id, or an owner id without a token, is still disabled', async () => {
    for (const [label, server] of [['token only', tokenOnly], ['owner id only', ownerOnly]]) {
      const res = await call(server, 'GET', '/api/claude/tasks', { token: TOKEN });
      assert.equal(res.status, 503, label);
      assert.deepEqual(res.json, { error: 'Claude API is disabled' }, label);
    }
  });
});

describe('Claude API settings: surrounding whitespace is ignored', () => {
  let blank;
  let padded;

  before(async () => {
    [blank, padded] = await Promise.all([
      startServer({ token: '   ', ownerId: '  ' }),
      startServer({ token: `  ${TOKEN}  `, ownerId: ` ${OWNER_ID} ` }),
    ]);
  });
  after(() => Promise.all([blank, padded].filter(Boolean).map((server) => server.stop())));

  it('settings that are only spaces count as not set -> 503', async () => {
    const res = await call(blank, 'GET', '/api/claude/tasks', { token: TOKEN });
    assert.equal(res.status, 503);
  });

  it('padded settings: the token works as the client sends it, and new rows get the trimmed owner id', async () => {
    const read = await claude(padded, 'GET', '/api/claude/tasks');
    assert.equal(read.status, 200);
    const created = await claude(padded, 'POST', '/api/claude/tasks', weeklyBody());
    assert.equal(created.status, 200);
    assert.equal(created.json.userId, OWNER_ID);
  });
});

// ---------------------------------------------------------------------------
// Enabled: token check, reading, and the existing routes
// ---------------------------------------------------------------------------

describe('Claude API (enabled): token check and reading', () => {
  let server;
  before(async () => {
    server = await startServer({ token: TOKEN, ownerId: OWNER_ID });
  });
  after(() => server && server.stop());

  it('[#2] no Authorization header -> 401', async () => {
    const res = await call(server, 'GET', '/api/claude/tasks');
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'Invalid token' });
  });

  it('[#2] a wrong token of the same length -> 401', async () => {
    const wrong = TOKEN.slice(0, -1) + (TOKEN.endsWith('0') ? '1' : '0');
    assert.equal(wrong.length, TOKEN.length);
    const res = await call(server, 'GET', '/api/claude/tasks', { token: wrong });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'Invalid token' });
    assert.ok(!res.text.includes(wrong), 'the response must not echo the token');
  });

  it('[#2] tokens of a different length (shorter, longer, huge) -> 401 and the server stays up', async () => {
    for (const wrong of ['x', TOKEN + 'x', TOKEN.slice(0, -1), 'y'.repeat(5000)]) {
      const res = await call(server, 'GET', '/api/claude/tasks', { token: wrong });
      assert.equal(res.status, 401, `length ${wrong.length}`);
      assert.deepEqual(res.json, { error: 'Invalid token' });
    }
    assert.equal(server.child.exitCode, null, 'the server process must still be running');
    const ok = await claude(server, 'GET', '/api/claude/tasks');
    assert.equal(ok.status, 200);
  });

  it('other schemes, a bare token and an empty Bearer -> 401', async () => {
    const basic = 'Basic ' + Buffer.from(`claude:${TOKEN}`).toString('base64');
    for (const header of [basic, TOKEN, 'Bearer', 'Bearer ', `Token ${TOKEN}`]) {
      const res = await call(server, 'GET', '/api/claude/tasks', { headers: { Authorization: header } });
      assert.equal(res.status, 401, JSON.stringify(header.slice(0, 12)));
    }
  });

  it('[#3] the right token: GET /api/claude/tasks -> 200 with the five level keys', async () => {
    const res = await claude(server, 'GET', '/api/claude/tasks');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), [...LEVELS].sort());
    for (const level of LEVELS) assert.ok(Array.isArray(res.json[level]), level);
  });

  it('an unknown path under /api/claude/ is a JSON 404, not the SPA page', async () => {
    const res = await claude(server, 'GET', '/api/claude/no-such-path');
    assert.equal(res.status, 404);
    assert.deepEqual(res.json, { error: 'Endpoint not found' });
  });

  it('[#13] /api/tasks still needs a Google login, even with the Claude token', async () => {
    const fileBefore = fs.existsSync(server.tasksFile) ? fs.readFileSync(server.tasksFile, 'utf8') : null;
    for (const token of [undefined, TOKEN]) {
      const label = token ? 'with the Claude token' : 'without a token';
      const get = await call(server, 'GET', '/api/tasks', { token });
      assert.equal(get.status, 401, `GET /api/tasks ${label}`);
      assert.deepEqual(get.json, { error: 'Authentication required' });
      const post = await call(server, 'POST', '/api/tasks', { token, body: weeklyBody() });
      assert.equal(post.status, 401, `POST /api/tasks ${label}`);
      const put = await call(server, 'PUT', '/api/tasks/task_x', { token, body: { title: 'x' } });
      assert.equal(put.status, 401, `PUT /api/tasks/:id ${label}`);
      const del = await call(server, 'DELETE', '/api/tasks/task_x', { token });
      assert.equal(del.status, 401, `DELETE /api/tasks/:id ${label}`);
    }
    const user = await claude(server, 'GET', '/api/user');
    assert.equal(user.status, 401, 'GET /api/user with the Claude token');
    const fileAfter = fs.existsSync(server.tasksFile) ? fs.readFileSync(server.tasksFile, 'utf8') : null;
    assert.equal(fileAfter, fileBefore, 'none of this may change the tasks');
  });

  it('the token and the Authorization header are never logged or sent back', async () => {
    const wrong = 'wrong-' + crypto.randomBytes(8).toString('hex');
    const responses = [
      await call(server, 'GET', '/api/claude/tasks', { token: wrong }),
      await claude(server, 'GET', '/api/claude/tasks'),
      await claude(server, 'POST', '/api/claude/tasks', weeklyBody({ category: 'Nope' })),
      await claude(server, 'PUT', '/api/claude/tasks/task_none', { title: 'x' }),
      // A body that does not parse goes down the error path of the server (and its log).
      await call(server, 'POST', '/api/claude/tasks', { token: TOKEN, body: '{"title": ' }),
    ];
    await sleep(300); // let the child's log lines arrive
    for (const res of responses) {
      const seen = res.text + JSON.stringify([...res.headers]);
      assert.ok(!seen.includes(TOKEN) && !seen.includes(wrong), 'a response contains a token');
    }
    const log = server.output();
    assert.ok(!log.includes(TOKEN) && !log.includes(wrong), 'the server log contains a token');
    assert.ok(!/bearer/i.test(log), 'the server log contains an Authorization header');
  });
});

// ---------------------------------------------------------------------------
// Enabled: create and bulk create
// ---------------------------------------------------------------------------

describe('Claude API (enabled): create and bulk create', () => {
  let server;
  before(async () => {
    server = await startServer({ token: TOKEN, ownerId: OWNER_ID });
  });
  after(() => server && server.stop());

  it('[#4] POST a weekly task with category and weekStart and no due date -> 200, owned by the owner id, saved', async () => {
    const res = await claude(server, 'POST', '/api/claude/tasks', {
      title: '週次レビュー',
      level: 'weekly',
      category: 'YCDC',
      weekStart: '2026-10-19',
    });
    assert.equal(res.status, 200);
    const row = res.json;
    assert.equal(row.userId, OWNER_ID);
    assert.equal(row.syncedToCalendar, false);
    assert.equal(row.dueDate, null);
    assert.equal(row.category, 'YCDC');
    assert.equal(row.weekStart, '2026-10-19');
    assert.equal(row.title, '週次レビュー');
    assert.equal(row.level, 'weekly');
    assert.equal(row.progress, 0);
    assert.equal(row.completed, false);
    assert.equal(row.repeat, 'none');
    assert.equal(row.parentId, null);
    assert.match(row.id, /^task_/);
    assert.equal(row.calendarEventId, undefined);

    const saved = findRow(readTasksFile(server), row.id);
    assert.deepEqual(saved, row, 'TASKS_FILE must hold the same row');
    assert.ok(readTasksFile(server).weekly.some((task) => task.id === row.id));
  });

  it('[#5] an invalid category, an invalid weekStart or no title -> 400, and nothing is written', async () => {
    const before = readTasksFile(server);
    const cases = {
      'invalid category': weeklyBody({ category: 'Nope' }),
      'invalid weekStart': weeklyBody({ weekStart: 'next monday' }),
      'no title': { level: 'weekly', category: 'YCDC', weekStart: '2026-10-19' },
    };
    for (const [label, body] of Object.entries(cases)) {
      const res = await claude(server, 'POST', '/api/claude/tasks', body);
      assert.equal(res.status, 400, label);
      assert.equal(typeof res.json.error, 'string', label);
    }
    assert.deepEqual(readTasksFile(server), before);
  });

  it('other bad input is a 400 too (blank title, bad level, bad date, wrong types, no JSON body)', async () => {
    const before = readTasksFile(server);
    const bodies = {
      'blank title': weeklyBody({ title: '   ' }),
      'title too long': weeklyBody({ title: 'a'.repeat(201) }),
      'description too long': weeklyBody({ description: 'a'.repeat(1001) }),
      'bad level': weeklyBody({ level: 'hourly' }),
      'bad dueDate': weeklyBody({ dueDate: 'tomorrow' }),
      'dueDate is a number': weeklyBody({ dueDate: 20261022 }),
      'weekStart is a number': weeklyBody({ weekStart: 5 }),
      'description is a number': weeklyBody({ description: 5 }),
      'parentId is an object': weeklyBody({ parentId: {} }),
      'body is an array': [],
    };
    for (const [label, body] of Object.entries(bodies)) {
      const res = await claude(server, 'POST', '/api/claude/tasks', body);
      assert.equal(res.status, 400, label);
    }
    const form = await call(server, 'POST', '/api/claude/tasks', {
      token: TOKEN,
      headers: { 'Content-Type': 'text/plain' },
      body: 'title=x',
    });
    assert.equal(form.status, 400, 'a body that is not JSON');
    assert.deepEqual(readTasksFile(server), before);
  });

  it('[#6] a title with 10/22 and A&B is stored as typed (no HTML escaping), only trimmed', async () => {
    const res = await claude(server, 'POST', '/api/claude/tasks',
      weeklyBody({ title: '  10/22 A&B 打ち合わせ  ', description: 'a/b & c <d> "e"' }));
    assert.equal(res.status, 200);
    assert.equal(res.json.title, '10/22 A&B 打ち合わせ');
    assert.equal(res.json.description, 'a/b & c <d> "e"');
    const saved = findRow(readTasksFile(server), res.json.id);
    assert.equal(saved.title, '10/22 A&B 打ち合わせ');
    assert.equal(saved.description, 'a/b & c <d> "e"');
    const raw = fs.readFileSync(server.tasksFile, 'utf8');
    assert.ok(!raw.includes('&#x2F;') && !raw.includes('&amp;'), 'the file holds escaped text');
  });

  it('the body cannot choose the owner, id, calendar link or progress of a new row', async () => {
    const res = await claude(server, 'POST', '/api/claude/tasks', weeklyBody({
      dueDate: '2026-10-22',
      userId: 'evil',
      id: 'task_chosen_by_caller',
      calendarEventId: 'evt_forged',
      syncedToCalendar: true,
      syncToCalendar: true,
      createdAt: '1999-01-01T00:00:00.000Z',
      completed: true,
      progress: 77,
      repeat: 'daily',
    }));
    assert.equal(res.status, 200);
    assert.equal(res.json.userId, OWNER_ID);
    assert.notEqual(res.json.id, 'task_chosen_by_caller');
    assert.equal(res.json.calendarEventId, undefined);
    assert.equal(res.json.syncedToCalendar, false);
    assert.equal(res.json.completed, false);
    assert.equal(res.json.progress, 0);
    assert.equal(res.json.repeat, 'none');
    assert.notEqual(res.json.createdAt, '1999-01-01T00:00:00.000Z');
    assert.equal(res.json.dueDate, '2026-10-22');
  });

  it('[#7] bulk: three valid tasks are created in the order sent, and saved', async () => {
    const before = readTasksFile(server);
    const items = [
      weeklyBody({ title: 'bulk 1' }),
      weeklyBody({ title: 'bulk 2', category: '株' }),
      { title: 'bulk 3', level: 'daily', dueDate: '2026-10-22', category: '事業' },
    ];
    const res = await claude(server, 'POST', '/api/claude/tasks/bulk', { tasks: items });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.created.map((task) => task.title), ['bulk 1', 'bulk 2', 'bulk 3']);
    assert.equal(new Set(res.json.created.map((task) => task.id)).size, 3);
    for (const task of res.json.created) {
      assert.equal(task.userId, OWNER_ID);
      assert.equal(task.syncedToCalendar, false);
    }

    const after = readTasksFile(server);
    assert.equal(countRows(after), countRows(before) + 3);
    assert.deepEqual(after.weekly.slice(-2).map((task) => task.title), ['bulk 1', 'bulk 2']);
    assert.equal(after.daily.at(-1).title, 'bulk 3');
    for (const task of res.json.created) assert.deepEqual(findRow(after, task.id), task);
  });

  it('[#7] bulk: an invalid second item -> 400 with index 1, and not a single task is created', async () => {
    const fileBefore = fs.readFileSync(server.tasksFile, 'utf8');
    const items = [
      weeklyBody({ title: 'fine' }),
      weeklyBody({ title: 'broken', category: 'Nope' }),
      weeklyBody({ title: 'also broken', weekStart: 'x' }),
    ];
    const res = await claude(server, 'POST', '/api/claude/tasks/bulk', { tasks: items });
    assert.equal(res.status, 400);
    assert.equal(res.json.index, 1, 'the position of the first invalid item');
    assert.equal(typeof res.json.error, 'string');

    assert.equal(fs.readFileSync(server.tasksFile, 'utf8'), fileBefore, 'the file must not change');
    const live = await claude(server, 'GET', '/api/claude/tasks');
    assert.deepEqual(live.json, JSON.parse(fileBefore), 'nothing may be added in memory either');
  });

  it('bulk: an item that is not an object is reported with its index', async () => {
    const before = readTasksFile(server);
    for (const [bad, index] of [[null, 2], [5, 2], ['text', 2], [[], 2]]) {
      const res = await claude(server, 'POST', '/api/claude/tasks/bulk', {
        tasks: [weeklyBody(), weeklyBody(), bad],
      });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.json.index, index, JSON.stringify(bad));
    }
    assert.deepEqual(readTasksFile(server), before);
  });

  it('[#8] bulk: 0 items -> 400 and 201 items -> 400, and nothing is created', async () => {
    const before = readTasksFile(server);
    const none = await claude(server, 'POST', '/api/claude/tasks/bulk', { tasks: [] });
    assert.equal(none.status, 400);
    const tooMany = await claude(server, 'POST', '/api/claude/tasks/bulk', {
      tasks: Array.from({ length: 201 }, (_, i) => weeklyBody({ title: `task ${i}` })),
    });
    assert.equal(tooMany.status, 400);
    assert.deepEqual(readTasksFile(server), before);
  });

  it('bulk: a body without a tasks array -> 400', async () => {
    for (const body of [{}, { tasks: 'nope' }, { tasks: {} }, [weeklyBody()]]) {
      const res = await claude(server, 'POST', '/api/claude/tasks/bulk', body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 30));
    }
  });

  it('bulk: exactly 200 items is accepted, in order (kept last: it adds 200 rows)', async () => {
    const before = readTasksFile(server);
    const items = Array.from({ length: 200 }, (_, i) => weeklyBody({ title: `limit ${i}` }));
    const res = await claude(server, 'POST', '/api/claude/tasks/bulk', { tasks: items });
    assert.equal(res.status, 200);
    assert.equal(res.json.created.length, 200);
    const after = readTasksFile(server);
    assert.equal(countRows(after), countRows(before) + 200);
    assert.deepEqual(after.weekly.slice(-200).map((task) => task.title), items.map((item) => item.title));
  });
});

// ---------------------------------------------------------------------------
// Enabled: update and delete
// ---------------------------------------------------------------------------

describe('Claude API (enabled): update and delete', () => {
  const seed = emptyStorage();
  seed.weekly.push(
    seedRow({ id: 'task_update', title: 'to update' }),
    seedRow({ id: 'task_sync', title: 'sync target' }),
    seedRow({ id: 'task_delete', title: 'to delete' }),
    seedRow({ id: 'task_other', title: 'owned by someone else', userId: OTHER_ID })
  );
  seed.daily.push(
    seedRow({
      id: 'task_calendar',
      title: 'linked to calendar',
      level: 'daily',
      dueDate: '2026-10-22',
      weekStart: null,
      syncedToCalendar: true,
      calendarEventId: 'evt_seed_1',
    })
  );

  let server;
  before(async () => {
    server = await startServer({ token: TOKEN, ownerId: OWNER_ID, seed });
  });
  after(() => server && server.stop());

  const rowOnDisk = (id) => findRow(readTasksFile(server), id);

  it('[#9] PUT on a row without a calendar event (category, weekStart, completed:true) -> 200, progress 100', async () => {
    const res = await claude(server, 'PUT', '/api/claude/tasks/task_update', {
      category: '株',
      weekStart: '2026-10-26',
      completed: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.id, 'task_update');
    assert.equal(res.json.category, '株');
    assert.equal(res.json.weekStart, '2026-10-26');
    assert.equal(res.json.completed, true);
    assert.equal(res.json.progress, 100);
    assert.equal(res.json.title, 'to update', 'fields that were not sent stay as they were');
    assert.deepEqual(rowOnDisk('task_update'), res.json, 'saved to TASKS_FILE');
  });

  it('PUT: un-completing keeps progress, and an explicit progress wins over the completed rule', async () => {
    const undone = await claude(server, 'PUT', '/api/claude/tasks/task_update', { completed: false });
    assert.equal(undone.status, 200);
    assert.equal(undone.json.completed, false);
    assert.equal(undone.json.progress, 100, 'progress is left as it was, like PUT /api/tasks/:id');

    const explicit = await claude(server, 'PUT', '/api/claude/tasks/task_update', { completed: true, progress: 40 });
    assert.equal(explicit.status, 200);
    assert.equal(explicit.json.completed, true);
    assert.equal(explicit.json.progress, 40);
  });

  it('PUT: title, description, dueDate and parentId can be changed and cleared on a row without a calendar event', async () => {
    const res = await claude(server, 'PUT', '/api/claude/tasks/task_update', {
      title: '  10/22 A&B  ',
      description: 'a/b & c',
      dueDate: '2026-10-30',
      parentId: 'task_parent',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.title, '10/22 A&B');
    assert.equal(res.json.description, 'a/b & c');
    assert.equal(res.json.dueDate, '2026-10-30');
    assert.equal(res.json.parentId, 'task_parent');
    const cleared = await claude(server, 'PUT', '/api/claude/tasks/task_update', {
      dueDate: null,
      parentId: null,
      weekStart: null,
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.dueDate, null);
    assert.equal(cleared.json.parentId, null);
    assert.equal(cleared.json.weekStart, null);
  });

  it('PUT: invalid values and unknown ids', async () => {
    const before = readTasksFile(server);
    for (const body of [
      { category: 'Nope' },
      { weekStart: 'monday' },
      { title: '' },
      { progress: 101 },
      { completed: 'yes' },
      { dueDate: 20261022 },
      { description: 5 },
      [],
    ]) {
      const res = await claude(server, 'PUT', '/api/claude/tasks/task_update', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const missing = await claude(server, 'PUT', '/api/claude/tasks/task_does_not_exist', { title: 'x' });
    assert.equal(missing.status, 404);
    assert.deepEqual(readTasksFile(server), before);
  });

  it('[#10] PUT on a row with a calendar event: changing completed -> 409 and nothing changes', async () => {
    const before = rowOnDisk('task_calendar');
    const res = await claude(server, 'PUT', '/api/claude/tasks/task_calendar', { completed: true });
    assert.equal(res.status, 409);
    assert.equal(typeof res.json.error, 'string');
    assert.deepEqual(rowOnDisk('task_calendar'), before);
    assert.equal(rowOnDisk('task_calendar').completed, false);

    const mixed = await claude(server, 'PUT', '/api/claude/tasks/task_calendar', { title: 'sneaky', completed: true });
    assert.equal(mixed.status, 409);
    assert.deepEqual(rowOnDisk('task_calendar'), before, 'a refused request changes nothing, not even the title');
  });

  it('PUT on a row with a calendar event: changing dueDate -> 409 and nothing changes', async () => {
    const before = rowOnDisk('task_calendar');
    for (const dueDate of ['2026-10-30', null]) {
      const res = await claude(server, 'PUT', '/api/claude/tasks/task_calendar', { dueDate });
      assert.equal(res.status, 409, String(dueDate));
    }
    assert.deepEqual(rowOnDisk('task_calendar'), before);
  });

  it('[#10] PUT on a row with a calendar event: changing the title (and other fields) -> 200', async () => {
    const res = await claude(server, 'PUT', '/api/claude/tasks/task_calendar', {
      title: 'renamed',
      description: 'new description',
      category: '事業',
      progress: 30,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.title, 'renamed');
    assert.equal(res.json.category, '事業');
    assert.equal(res.json.progress, 30);
    assert.equal(res.json.calendarEventId, 'evt_seed_1', 'the calendar link is untouched');
    assert.equal(res.json.syncedToCalendar, true);
    assert.equal(res.json.completed, false);
    assert.equal(res.json.dueDate, '2026-10-22');
    assert.deepEqual(rowOnDisk('task_calendar'), res.json);
  });

  it('PUT on a row with a calendar event: re-sending the current completed and dueDate is not a change', async () => {
    const res = await claude(server, 'PUT', '/api/claude/tasks/task_calendar', {
      completed: false,
      dueDate: '2026-10-22',
      title: 'renamed again',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.title, 'renamed again');
    assert.equal(res.json.completed, false);
    assert.equal(res.json.dueDate, '2026-10-22');
  });

  it('[#11] PUT with syncToCalendar in the body -> 400 (true or false), and nothing changes', async () => {
    const before = rowOnDisk('task_sync');
    for (const syncToCalendar of [true, false, null]) {
      const res = await claude(server, 'PUT', '/api/claude/tasks/task_sync', { title: 'changed', syncToCalendar });
      assert.equal(res.status, 400, String(syncToCalendar));
    }
    assert.deepEqual(rowOnDisk('task_sync'), before);
  });

  it('PUT and DELETE only reach rows owned by the owner id: someone else\'s row is a 404', async () => {
    const before = rowOnDisk('task_other');
    const put = await claude(server, 'PUT', '/api/claude/tasks/task_other', { title: 'taken over' });
    assert.equal(put.status, 404);
    const del = await claude(server, 'DELETE', '/api/claude/tasks/task_other');
    assert.equal(del.status, 404);
    assert.deepEqual(rowOnDisk('task_other'), before);
  });

  it('[#12] DELETE a row without a calendar event -> 200 with the deleted row, and it is gone', async () => {
    const before = rowOnDisk('task_delete');
    assert.ok(before);
    const res = await claude(server, 'DELETE', '/api/claude/tasks/task_delete');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, before);
    assert.equal(rowOnDisk('task_delete'), undefined);
    const live = await claude(server, 'GET', '/api/claude/tasks');
    assert.ok(!allRows(live.json).some((task) => task.id === 'task_delete'));
  });

  it('[#12] DELETE a row with a calendar event -> 409 and the row stays', async () => {
    const before = rowOnDisk('task_calendar');
    const res = await claude(server, 'DELETE', '/api/claude/tasks/task_calendar');
    assert.equal(res.status, 409);
    assert.equal(typeof res.json.error, 'string');
    assert.deepEqual(rowOnDisk('task_calendar'), before);
  });

  it('[#12] DELETE an unknown id -> 404', async () => {
    const before = readTasksFile(server);
    const res = await claude(server, 'DELETE', '/api/claude/tasks/task_does_not_exist');
    assert.equal(res.status, 404);
    assert.deepEqual(readTasksFile(server), before);
  });
});

// ---------------------------------------------------------------------------
// Enabled: text in the wrong encoding (U+FFFD) is refused
// ---------------------------------------------------------------------------

describe('Claude API (enabled): a title or description with U+FFFD (wrong encoding) is refused', () => {
  const REFUSED = { error: 'Text contains U+FFFD; send the body as UTF-8' };
  const GARBLED = 'broken ' + String.fromCodePoint(0xFFFD) + ' text';
  const seed = emptyStorage();
  seed.weekly.push(seedRow({ id: 'task_enc', title: 'readable' }));

  let server;
  before(async () => {
    server = await startServer({ token: TOKEN, ownerId: OWNER_ID, seed });
  });
  after(() => server && server.stop());

  const fileText = () => fs.readFileSync(server.tasksFile, 'utf8');

  it('[#14] POST, bulk (second item only) and PUT with U+FFFD in the title -> 400, and the file does not change', async () => {
    const before = fileText();

    const post = await claude(server, 'POST', '/api/claude/tasks', weeklyBody({ title: GARBLED }));
    assert.equal(post.status, 400);
    assert.deepEqual(post.json, REFUSED);

    const bulk = await claude(server, 'POST', '/api/claude/tasks/bulk', {
      tasks: [weeklyBody({ title: 'fine 1' }), weeklyBody({ title: GARBLED }), weeklyBody({ title: 'fine 3' })],
    });
    assert.equal(bulk.status, 400);
    assert.deepEqual(bulk.json, { ...REFUSED, index: 1 });

    const put = await claude(server, 'PUT', '/api/claude/tasks/task_enc', { title: GARBLED });
    assert.equal(put.status, 400);
    assert.deepEqual(put.json, REFUSED);

    assert.equal(fileText(), before, 'the file must not change');
    const live = await claude(server, 'GET', '/api/claude/tasks');
    assert.deepEqual(live.json, JSON.parse(before), 'nor the data in memory');
  });

  it('[#14] the shared rules behind POST /api/tasks and PUT /api/tasks/:id do not have the check (code check)', () => {
    const source = fs.readFileSync(SERVER_ENTRY, 'utf8');
    const marker = source.indexOf('Claude API: read and write tasks');
    assert.ok(marker > 0, 'the Claude API section was not found in server/index.js');
    // Everything before that section: taskInputError / taskUpdateError with the middleware around
    // them, and all the existing routes.
    const existing = source.slice(0, marker);
    for (const name of ['taskInputError', 'taskUpdateError', "app.post('/api/tasks'", "app.put('/api/tasks/:id'"]) {
      assert.ok(existing.includes(name), `expected ${name} before the Claude API section`);
    }
    assert.ok(!/fffd/i.test(existing) && !existing.includes(String.fromCodePoint(0xFFFD)), 'the existing rules must not look for U+FFFD');
    assert.ok(!existing.includes('claudeTextError'), 'the Claude-only check must not be used by the existing rules');
    assert.ok(/fffd/i.test(source.slice(marker)), 'the check should exist in the Claude API section');
  });

  it('a description with U+FFFD is refused too (POST, bulk, PUT)', async () => {
    const before = fileText();
    const post = await claude(server, 'POST', '/api/claude/tasks', weeklyBody({ description: GARBLED }));
    assert.equal(post.status, 400);
    assert.deepEqual(post.json, REFUSED);
    const bulk = await claude(server, 'POST', '/api/claude/tasks/bulk', {
      tasks: [weeklyBody(), weeklyBody({ description: GARBLED })],
    });
    assert.equal(bulk.status, 400);
    assert.deepEqual(bulk.json, { ...REFUSED, index: 1 });
    const put = await claude(server, 'PUT', '/api/claude/tasks/task_enc', { description: GARBLED });
    assert.equal(put.status, 400);
    assert.deepEqual(put.json, REFUSED);
    assert.equal(fileText(), before);
  });

  it('a body in Shift-JIS (what Git\'s curl sends for Japanese typed after -d) is refused, not saved garbled', async () => {
    const before = fileText();
    const sjis = Buffer.from('93fa967b8cea', 'hex'); // 日本語 in Shift-JIS: not valid UTF-8
    const body = Buffer.concat([Buffer.from('{"title":"'), sjis, Buffer.from('","level":"weekly"}')]);
    const res = await call(server, 'POST', '/api/claude/tasks', { token: TOKEN, body });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, REFUSED);
    assert.equal(fileText(), before);
  });

  it('the JSON escape \\ufffd is the same character and is refused too', async () => {
    const res = await call(server, 'POST', '/api/claude/tasks', {
      token: TOKEN,
      body: '{"title":"x\\ufffdy","level":"weekly"}',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, REFUSED);
  });

  it('Japanese text that is valid UTF-8 is accepted and stored as it is', async () => {
    const res = await claude(server, 'POST', '/api/claude/tasks',
      weeklyBody({ title: '日本語のタイトル', description: '説明: 10/22 A&B' }));
    assert.equal(res.status, 200);
    assert.equal(res.json.title, '日本語のタイトル');
    const saved = findRow(readTasksFile(server), res.json.id);
    assert.equal(saved.title, '日本語のタイトル');
    assert.equal(saved.description, '説明: 10/22 A&B');
  });
});

// ---------------------------------------------------------------------------
// Enabled: a failed save is a 500 and nothing changes
// ---------------------------------------------------------------------------

describe('Claude API (enabled): when the file cannot be saved, the answer is 500 and nothing changes', () => {
  // An older row has no category / weekStart; a failed PUT that adds them must take them out again.
  const oldRow = seedRow({ id: 'task_put', title: 'to update' });
  delete oldRow.category;
  delete oldRow.weekStart;
  // No `quarterly` array on purpose: a failed bulk create must not leave an empty one behind.
  const seed = {
    yearly: [],
    monthly: [seedRow({ id: 'task_month', level: 'monthly', title: 'monthly' })],
    weekly: [
      seedRow({ id: 'task_first', title: 'first' }),
      seedRow({ id: 'task_delete', title: 'to delete' }),
      oldRow,
      seedRow({ id: 'task_last', title: 'last' }),
    ],
    daily: [],
  };

  let server;
  before(async () => {
    server = await startServer({ token: TOKEN, ownerId: OWNER_ID, seed });
  });
  after(() => server && server.stop());

  // Renaming can fail for a moment on Windows while a virus scanner still has the new file open.
  const retry = async (action) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return action();
      } catch (err) {
        if (attempt >= 5) throw err;
        await sleep(100);
      }
    }
  };
  // The server read the file when it started. Put a directory where the file was: reading the data in
  // memory still works, but every write to that path fails. (Works for any user, unlike read-only flags.)
  const makeUnwritable = async () => {
    await retry(() => fs.renameSync(server.tasksFile, server.tasksFile + '.saved'));
    fs.mkdirSync(server.tasksFile);
  };
  const makeWritable = async () => {
    fs.rmdirSync(server.tasksFile);
    await retry(() => fs.renameSync(server.tasksFile + '.saved', server.tasksFile));
  };

  it('[#15] POST, bulk, PUT and DELETE are 500 "Failed to save tasks", and GET shows the data as it was', async () => {
    const before = (await claude(server, 'GET', '/api/claude/tasks')).json;
    assert.ok(!('quarterly' in before), 'the seed has no quarterly array');

    await makeUnwritable();
    try {
      const failures = {
        POST: await claude(server, 'POST', '/api/claude/tasks', weeklyBody({ title: 'not saved' })),
        bulk: await claude(server, 'POST', '/api/claude/tasks/bulk', {
          tasks: [
            weeklyBody({ title: 'bulk 1' }),
            { title: 'bulk 2', level: 'quarterly', category: '事業' },
            { title: 'bulk 3', level: 'yearly' },
          ],
        }),
        PUT: await claude(server, 'PUT', '/api/claude/tasks/task_put', {
          title: 'changed',
          description: 'changed too',
          category: '株',
          weekStart: '2026-10-26',
          dueDate: '2026-10-30',
          completed: true,
        }),
        DELETE: await claude(server, 'DELETE', '/api/claude/tasks/task_delete'),
      };
      for (const [name, res] of Object.entries(failures)) {
        assert.equal(res.status, 500, name);
        assert.deepEqual(res.json, { error: 'Failed to save tasks' }, name);
      }

      const after = (await claude(server, 'GET', '/api/claude/tasks')).json;
      assert.deepEqual(after, before);
      assert.equal(JSON.stringify(after), JSON.stringify(before), 'same order of rows and of keys, too');
    } finally {
      await makeWritable();
    }
    assert.deepEqual(readTasksFile(server), seed, 'the file itself was never touched');
  });

  it('once the file is writable again, the next save holds the original data plus only that new row', async () => {
    const created = await claude(server, 'POST', '/api/claude/tasks', weeklyBody({ title: 'after the failures' }));
    assert.equal(created.status, 200);
    const expected = structuredClone(seed);
    expected.weekly.push(created.json);
    assert.deepEqual(readTasksFile(server), expected);
  });
});

// ---------------------------------------------------------------------------
// apiLimiter still covers /api/claude/
// ---------------------------------------------------------------------------

describe('apiLimiter (50 requests per 15 minutes) still applies under /api/claude/', () => {
  let server;
  before(async () => {
    server = await startServer({ token: TOKEN, ownerId: OWNER_ID });
  });
  after(() => server && server.stop());

  it('the 50th request still gets through and the 51st is 429', async () => {
    for (let i = 1; i <= 50; i++) {
      const res = await call(server, 'GET', '/api/claude/tasks'); // no token: a cheap 401 each time
      assert.equal(res.status, 401, `request ${i}`);
    }
    const res = await call(server, 'GET', '/api/claude/tasks');
    assert.equal(res.status, 429, 'request 51');
  });
});
