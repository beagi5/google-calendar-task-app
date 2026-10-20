'use strict';

/*
 * Reads the Notion database "やること" (to-dos) and writes back its "済" (done) checkbox.
 * It is the back end of the "やること（Notion）" card: GET /api/yarukoto and
 * PATCH /api/yarukoto/:pageId in index.js are thin wrappers around createRoutes() below.
 *
 * - Nothing in here depends on Express or has a network of its own. The client takes `fetch` and
 *   `sleep` as arguments, and the route handlers only use req.params, req.body, res.status(),
 *   res.json() and res.set(). That is what lets notion.test.js run every case against a fake
 *   fetch and a fake req/res.
 * - The token lives only inside createClient. It is never put in an error message, a log line or a
 *   response (see `redact`), and it is never sent to the browser.
 */

const DEFAULT_API_BASE = 'https://api.notion.com';
const DEFAULT_VERSION = '2026-03-11';

const PAGE_SIZE = 100; // the most the query endpoint returns per request
const MAX_PAGES = 50; // a stop for a response that never says has_more: false
const REQUEST_TIMEOUT_MS = 15000;
const RETRY_AFTER_MAX_SECONDS = 5; // 429 / 529 with a longer Retry-After is not waited for
const CACHE_TTL_MS = 15000; // how long the list is served from memory
const RETURNED_TTL_MS = 60 * 60 * 1000; // how long a row that left the list can still be written

// Column names of the Notion database, exactly as they are written in Notion.
const COL = {
  title: '名前',
  done: '済',
  kind: '種類',
  business: '事業',
  project: 'プロジェクト',
  week: '予定週',
  priority: '優先',
  criteria: '完了条件',
  deadline: '締切',
  source: '出典',
  stale: '滞留',
};
const KIND_ONE_HOUR = '1時間';

// kind: 'busy'       Notion answered 429 / 529 and waiting would not help (or did not)
//       'failed'     anything else that went wrong while talking to Notion
//       'not_found'  the row was not in any list returned within the last hour (nothing was sent to Notion)
// The message is safe to log: it never contains the token.
class NotionError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = 'NotionError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// "Retry-After: 3" -> 3. Anything that is not a plain number of seconds -> null.
function parseRetryAfter(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return /^\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

// What a failed fetch() says about itself, without its message (which could carry anything).
function describeFetchError(err) {
  const name = err && typeof err.name === 'string' ? err.name : 'Error';
  const code = err && err.cause && typeof err.cause.code === 'string' ? err.cause.code : '';
  return code ? `${name} (${code})` : name;
}

// ---------------------------------------------------------------------------
// Client: one small place that talks to the Notion API
// ---------------------------------------------------------------------------

function createClient({
  token,
  apiBase = DEFAULT_API_BASE,
  version = DEFAULT_VERSION,
  fetch: fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (typeof token !== 'string' || token === '') throw new TypeError('token is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is not available');
  const base = String(apiBase).replace(/\/+$/, '');

  // Every text that can reach a log or an error goes through this: the token is cut out of it.
  const redact = (text) => String(text).split(token).join('[redacted]');

  const httpError = async (res) => {
    let detail = '';
    try {
      const data = await res.json();
      if (data && typeof data.code === 'string' && /^[a-z_]{1,64}$/.test(data.code)) detail += ` ${data.code}`;
      if (data && typeof data.message === 'string') detail += `: ${data.message.slice(0, 200)}`;
    } catch {
      // not JSON: the status alone will do
    }
    return new NotionError('failed', redact(`Notion API error: HTTP ${res.status}${detail}`), res.status);
  };

  // One request. 429 / 529 with "Retry-After" of 5 seconds or less is waited for and tried once
  // more; a longer one, a missing one, or a second 429 / 529 is a 'busy' error.
  async function request(method, path, body) {
    for (let attempt = 1; ; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(base + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': version,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new NotionError('failed', redact(`Notion request error: ${describeFetchError(err)}`));
      }

      if (res.ok) {
        try {
          return await res.json();
        } catch {
          throw new NotionError('failed', 'Notion answered with something that is not JSON', res.status);
        }
      }

      if (res.status === 429 || res.status === 529) {
        const seconds = parseRetryAfter(res.headers && res.headers.get ? res.headers.get('retry-after') : null);
        if (typeof res.text === 'function') await res.text().catch(() => {}); // let go of the connection
        if (attempt === 1 && seconds !== null && seconds <= RETRY_AFTER_MAX_SECONDS) {
          await sleep(seconds * 1000);
          continue;
        }
        throw new NotionError('busy', `Notion is busy (HTTP ${res.status})`, res.status);
      }

      throw await httpError(res);
    }
  }

  return {
    redact,

    // Every page of a data source that matches `filter`, following has_more to the end.
    async queryAll(dataSourceId, filter) {
      const path = `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`;
      const pages = [];
      let cursor;
      for (let count = 0; count < MAX_PAGES; count += 1) {
        const body = { filter, page_size: PAGE_SIZE };
        if (cursor !== undefined) body.start_cursor = cursor;
        const data = await request('POST', path, body);
        if (data && Array.isArray(data.results)) pages.push(...data.results);
        if (!data || !data.has_more) return pages;
        if (typeof data.next_cursor !== 'string' || data.next_cursor === '') {
          throw new NotionError('failed', 'Notion said there is more but gave no cursor');
        }
        cursor = data.next_cursor;
      }
      throw new NotionError('failed', `Notion returned more than ${MAX_PAGES} pages`);
    },

    // PATCH /v1/pages/{id} with { properties }.
    async updatePage(pageId, properties) {
      await request('PATCH', `/v1/pages/${encodeURIComponent(pageId)}`, { properties });
    },
  };
}

// ---------------------------------------------------------------------------
// What to read, and how a Notion page becomes a row for the screen
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

// The Monday ('YYYY-MM-DD', server local time) of the week that contains `date`.
// Same rule as src/utils/week.js: Sunday is the last day of the week, not the first.
function mondayISO(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay(); // 0 = Sunday
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local midnight at the start of the day of `date`, as the UTC ('Z') string that Notion's timestamp
// filter takes (Japan time 2026-10-20 00:00 -> '2026-10-19T15:00:00.000Z'). Server local time.
function startOfDayISO(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
}

// 種類 = 1時間, and any of:
//  - not done yet (any week, or none),
//  - planned for this week's Monday or later (done or not),
//  - last edited today, from 0:00 on (a row done today in an earlier week, or with no week, so the
//    screen can count it for today's goal). "Done and edited today" is written as just "edited
//    today": a row that is not done is matched by the first line anyway, and an `and` inside this
//    `or` would be a third level of nesting, which Notion does not take.
// Other done rows (of the past weeks, or with no week) are left out.
// The timestamp condition has no `property` key (Notion refuses one) and its value is in UTC.
function buildFilter(now = new Date()) {
  return {
    and: [
      { property: COL.kind, select: { equals: KIND_ONE_HOUR } },
      {
        or: [
          { property: COL.done, checkbox: { equals: false } },
          { property: COL.week, date: { on_or_after: mondayISO(now) } },
          { timestamp: 'last_edited_time', last_edited_time: { on_or_after: startOfDayISO(now) } },
        ],
      },
    ],
  };
}

// The business (事業) column -> the category buttons of the screen.
// YCDC -> YCDC, 株 -> 株, Webサイト / 自動収入 -> 事業, 事務 -> マネジメント.
// その他, an empty column and any option added later: マネジメント when the name has 「会社化」, else その他.
function categoryOf(business, title) {
  switch (business) {
    case 'YCDC':
      return 'YCDC';
    case '株':
      return '株';
    case 'Webサイト':
    case '自動収入':
      return '事業';
    case '事務':
      return 'マネジメント';
    default:
      return typeof title === 'string' && title.includes('会社化') ? 'マネジメント' : 'その他';
  }
}

// The readers below never throw: a column that is missing, or not of the type we expect, gives null
// (the title gives '' and the checkbox false, so the screen always has a string and a boolean).
const propertyOf = (page, name) => {
  const properties = page && page.properties;
  return properties && typeof properties === 'object' ? properties[name] : undefined;
};

const joinPlainText = (parts) =>
  Array.isArray(parts) ? parts.map((part) => (part && typeof part.plain_text === 'string' ? part.plain_text : '')).join('') : '';

const readTitle = (prop) => joinPlainText(prop && prop.title);

const readCheckbox = (prop) => !!prop && prop.checkbox === true;

const readSelect = (prop) => (prop && prop.select && typeof prop.select.name === 'string' ? prop.select.name : null);

// A date column -> its 'YYYY-MM-DD' part only. `start` may carry a time and an offset.
const readDate = (prop) => {
  const start = prop && prop.date && typeof prop.date.start === 'string' ? prop.date.start : '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(start);
  return match ? match[1] : null;
};

const readNumber = (prop) => (prop && typeof prop.number === 'number' && Number.isFinite(prop.number) ? prop.number : null);

const readText = (prop) => {
  const text = joinPlainText(prop && prop.rich_text);
  return text.trim() === '' ? null : text;
};

const readUrl = (prop) => (prop && typeof prop.url === 'string' && prop.url !== '' ? prop.url : null);

// Only a formula that gives a text is used ({ type: 'unsupported' }, numbers and so on -> null).
const readFormulaText = (prop) => {
  const formula = prop && prop.formula;
  return formula && formula.type === 'string' && typeof formula.string === 'string' && formula.string !== ''
    ? formula.string
    : null;
};

// One Notion page -> the row the screen shows. null when it is not a page (no id), or a partial page
// (no `properties` at all: Notion's types allow those, but with read access they do not come).
function toItem(page) {
  if (!page || typeof page.id !== 'string' || page.id === '') return null;
  if (!page.properties || typeof page.properties !== 'object' || Array.isArray(page.properties)) return null;
  const get = (name) => propertyOf(page, name);
  const title = readTitle(get(COL.title));
  const business = readSelect(get(COL.business));
  return {
    id: page.id,
    url: typeof page.url === 'string' && page.url !== '' ? page.url : null,
    title,
    done: readCheckbox(get(COL.done)),
    weekStart: readDate(get(COL.week)),
    priority: readNumber(get(COL.priority)),
    business,
    category: categoryOf(business, title),
    project: readSelect(get(COL.project)),
    criteria: readText(get(COL.criteria)),
    deadline: readDate(get(COL.deadline)),
    source: readUrl(get(COL.source)),
    stale: readFormulaText(get(COL.stale)),
    // When Notion says the page was last edited: the page's own last_edited_time, as the text it came in.
    lastEdited: typeof page.last_edited_time === 'string' && page.last_edited_time !== '' ? page.last_edited_time : null,
  };
}

// Earlier week first (no week = 後で = last), then smaller 優先 first (none = last), then by title.
function sortItems(items) {
  const nullLast = (a, b) => {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? -1 : 1;
  };
  return [...items].sort(
    (a, b) => nullLast(a.weekStart, b.weekStart) || nullLast(a.priority, b.priority) || nullLast(a.title, b.title)
  );
}

// ---------------------------------------------------------------------------
// Service: the list (remembered for 15 seconds), the ids it returned (remembered for an hour), and the write
// ---------------------------------------------------------------------------

const PAGE_ID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// 32 hex digits, with the hyphens in their usual places or without any.
const isValidPageId = (value) => typeof value === 'string' && PAGE_ID_PATTERN.test(value);

// The same page, whether its id is written with or without hyphens, in upper or lower case.
const idKey = (id) => String(id).replace(/-/g, '').toLowerCase();

function createYarukoto({
  client,
  dataSourceId,
  ttlMs = CACHE_TTL_MS,
  returnedTtlMs = RETURNED_TTL_MS,
  now = Date.now,
  today = () => new Date(),
}) {
  let cache = null; // { items, at }
  let inFlight = null; // the read that is running, so that two requests at once cost one Notion call
  let generation = 0; // goes up with every write: a read that began before it must not be remembered
  // Every id that a returned list contained -> { id, at }: the id as Notion writes it, and the time
  // of the last list that had it. A row that has just been set to done no longer matches the read
  // condition (see buildFilter), so the lists that follow do not have it; this is what still lets it
  // be set back. Only ids that Notion itself returned are ever in here.
  const returned = new Map();

  const read = () => {
    if (inFlight) return inFlight;
    const startedGeneration = generation;
    const startedAt = now();
    const promise = (async () => {
      const pages = await client.queryAll(dataSourceId, buildFilter(today()));
      const ids = new Set();
      const items = [];
      for (const page of pages) {
        const item = toItem(page);
        if (item && !ids.has(item.id)) {
          ids.add(item.id);
          items.push(item);
        }
      }
      const sorted = sortItems(items);
      if (startedGeneration === generation) cache = { items: sorted, at: startedAt };
      return sorted;
    })().finally(() => {
      if (inFlight === promise) inFlight = null;
    });
    inFlight = promise;
    return promise;
  };

  // Notes that these rows were just returned, and forgets the ids that were last returned more than
  // an hour ago (so that the map stays as small as the list).
  const markReturned = (items) => {
    const at = now();
    for (const item of items) returned.set(idKey(item.id), { id: item.id, at });
    for (const [key, entry] of returned) {
      if (at - entry.at > returnedTtlMs) returned.delete(key);
    }
  };

  // The entry of an id that was returned within the last hour (an hour exactly still counts; "more
  // than an hour ago" does not), else undefined.
  const recentlyReturned = (pageId) => {
    const entry = returned.get(idKey(pageId));
    return entry && now() - entry.at <= returnedTtlMs ? entry : undefined;
  };

  // The rows, from memory when they were read less than ttlMs ago. Every call, from the screen or
  // from setDone, counts as "returned" for the ids in it.
  const list = async () => {
    const items = cache && now() - cache.at < ttlMs ? cache.items : await read();
    markReturned(items);
    return items;
  };

  // Sets 済 on one row, but only a row that Notion returned in a list within the last hour, so this
  // can never write to a page outside the database. An id that was not returned in that time is
  // looked for in the list as it is now (read again first if the 15-second memory has run out) and,
  // if it is not there either, is 'not_found' without anything being sent to Notion. Whatever the
  // outcome of the write, the remembered list is dropped.
  const setDone = async (pageId, done) => {
    let known = recentlyReturned(pageId);
    if (!known) {
      await list(); // whatever it returns is remembered, so the row is found below if it is in it
      known = recentlyReturned(pageId);
    }
    if (!known) throw new NotionError('not_found', 'The row was not in a list returned within the last hour');
    try {
      await client.updatePage(known.id, { [COL.done]: { checkbox: done } });
    } finally {
      generation += 1;
      cache = null;
      inFlight = null;
    }
    return { id: known.id, done };
  };

  return { list, setDone, redact: client.redact };
}

// From the settings (environment variables). null when the token or the data source id is missing:
// the routes then answer 503. Surrounding whitespace in a setting is ignored.
function createYarukotoFromEnv(env = process.env, overrides = {}) {
  const read = (name) => (typeof env[name] === 'string' ? env[name].trim() : '');
  const token = read('NOTION_TOKEN');
  const dataSourceId = read('NOTION_YARUKOTO_DATA_SOURCE_ID');
  if (token === '' || dataSourceId === '') return null;
  const client = createClient({
    token,
    apiBase: read('NOTION_API_BASE') || undefined,
    version: read('NOTION_VERSION') || undefined,
    ...overrides,
  });
  return createYarukoto({ client, dataSourceId });
}

// ---------------------------------------------------------------------------
// Route handlers (Express-style; index.js puts requireAuth in front of them)
// ---------------------------------------------------------------------------

// `service` is what createYarukoto returns, or null when Notion is not configured.
function createRoutes(service, { log = (...args) => console.error(...args) } = {}) {
  const scrub = (text) => (service && service.redact ? service.redact(text) : String(text));

  // The answer says nothing about the cause; the log line has it (with the token cut out).
  const fail = (res, err) => {
    if (err instanceof NotionError && err.kind === 'not_found') {
      return res.status(404).json({ error: 'Not found' });
    }
    const busy = err instanceof NotionError && err.kind === 'busy';
    log(scrub(`${busy ? 'Notion is busy' : 'Notion request failed'}: ${err && err.message}`));
    return busy
      ? res.status(503).json({ error: 'Notion is busy, try again later' })
      : res.status(502).json({ error: 'Notion request failed' });
  };

  return {
    // GET /api/yarukoto -> { items }
    async list(req, res) {
      if (!service) return res.status(503).json({ error: 'Notion is not configured' });
      try {
        const items = await service.list();
        res.set('Cache-Control', 'no-store');
        return res.json({ items });
      } catch (err) {
        return fail(res, err);
      }
    },

    // PATCH /api/yarukoto/:pageId with { done: true | false } -> { id, done }
    async update(req, res) {
      if (!service) return res.status(503).json({ error: 'Notion is not configured' });
      const pageId = req.params && req.params.pageId;
      if (!isValidPageId(pageId)) return res.status(400).json({ error: 'Invalid page id' });
      const done = req.body ? req.body.done : undefined;
      if (typeof done !== 'boolean') return res.status(400).json({ error: 'done must be true or false' });
      try {
        return res.json(await service.setDone(pageId, done));
      } catch (err) {
        return fail(res, err);
      }
    },
  };
}

module.exports = {
  NotionError,
  createClient,
  createYarukoto,
  createYarukotoFromEnv,
  createRoutes,
  buildFilter,
  categoryOf,
  isValidPageId,
  mondayISO,
  startOfDayISO,
  sortItems,
  toItem,
};
