'use strict';

/*
 * Tests for server/notion.js (the Notion "やること" client, the list / write service, the route
 * handlers) and for the /api/yarukoto routes in server/index.js.
 * Run with: cd server && npm test   (node --test; no extra dependencies)
 *
 * - The real Notion is never called. The client, the service and the handlers run against a fake
 *   fetch and a fake req/res, with a fake clock where time matters.
 * - The last describe() starts the real server (a child process, as claude-api.test.js does, with
 *   TASKS_FILE in the OS temp dir and dummy Google values) to check that both routes ask for a
 *   Google login, and that a visitor who is not logged in never makes it reach Notion.
 * - Tests tagged [#1]..[#12] are the twelve required items:
 *   #1 request shape, #2 paging, #3 row conversion, #4 order, #5 categories, #6 write request,
 *   #7 429 / Retry-After, #8 no token in any error text, #9 an id that is not in the list,
 *   #10 a row set to done (so it leaves the list) can be set back, for an hour after the last list that had it,
 *   #11 the read condition has "last edited today" (timestamp last_edited_time, UTC, no `property` key),
 *   #12 a row has `lastEdited` (null when the page has none).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const notion = require('../notion');

const TOKEN = 'ntn_test_' + crypto.randomBytes(16).toString('hex');
const DATA_SOURCE_ID = 'dc85c209-3e4d-419a-aec1-37d082a1c65f';
const THIS_MONDAY = '2026-10-19';
const NEXT_MONDAY = '2026-10-26';
const LAST_MONDAY = '2026-10-12';
// Local time, so the week does not depend on the time zone of the machine running the tests:
// a Wednesday, in the week whose Monday is 2026-10-19.
const WEDNESDAY = new Date(2026, 9, 21, 12, 0, 0);
// The last_edited_time that a test page has unless the test says otherwise (a text, as Notion sends it).
const EDITED = '2026-10-19T03:15:00.000Z';

// ---------------------------------------------------------------------------
// Fakes: Notion pages, Notion responses, fetch, req / res
// ---------------------------------------------------------------------------

// Has hex letters in it, so that upper / lower case of an id makes a difference.
const uuid = (n) => `abcdef00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ID1 = uuid(1);
const ID2 = uuid(2);
const ID3 = uuid(3);

const richText = (text) => [{ type: 'text', text: { content: text }, plain_text: text, annotations: {}, href: null }];

/**
 * A Notion page of the database, shaped as the API returns it. `lastEdited: null` leaves out the
 * page's last_edited_time.
 */
const notionPage = (id, o = {}) => {
  const {
    title = 'task', done = false, kind = '1時間', business = null, project = null,
    week = null, priority = null, criteria = null, deadline = null, source = null, stale = null,
    lastEdited = EDITED,
  } = o;
  const select = (name) => ({ type: 'select', select: name === null ? null : { id: 'x', name, color: 'default' } });
  return {
    object: 'page',
    id,
    ...(lastEdited === null ? {} : { last_edited_time: lastEdited }),
    url: `https://www.notion.so/${id.replace(/-/g, '')}`,
    properties: {
      名前: { id: 'title', type: 'title', title: richText(title) },
      済: { id: 'a', type: 'checkbox', checkbox: done },
      種類: select(kind),
      事業: select(business),
      プロジェクト: select(project),
      予定週: { id: 'b', type: 'date', date: week === null ? null : { start: week, end: null, time_zone: null } },
      優先: { id: 'c', type: 'number', number: priority },
      完了条件: { id: 'd', type: 'rich_text', rich_text: criteria === null ? [] : richText(criteria) },
      締切: { id: 'e', type: 'date', date: deadline === null ? null : { start: deadline, end: null, time_zone: null } },
      出典: { id: 'f', type: 'url', url: source },
      滞留: { id: 'g', type: 'formula', formula: stale === null ? { type: 'string', string: '' } : { type: 'string', string: stale } },
    },
  };
};

const jsonHeaders = { 'content-type': 'application/json' };
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders });
const failure = (status, body = {}, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...jsonHeaders, ...headers } });
const queryResponse = (pages, nextCursor = null) =>
  ok({ object: 'list', results: pages, has_more: nextCursor !== null, next_cursor: nextCursor });
const updateResponse = (id) => ok({ object: 'page', id });

/**
 * A fetch that answers with the given steps in order. A step is a Response, an Error (thrown), or a
 * function(call) returning one of those (it may be async). Asking for more than were given throws,
 * which shows up as a failed request. `calls` holds what was sent, the body already parsed.
 */
function fakeFetch(...steps) {
  const queue = [...steps];
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method,
      headers: { ...init.headers },
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      signal: init.signal,
    };
    calls.push(call);
    if (queue.length === 0) throw new Error(`unexpected fetch #${calls.length}: ${call.method} ${call.url}`);
    const step = queue.shift();
    const value = typeof step === 'function' ? await step(call) : step;
    if (value instanceof Error) throw value;
    return value;
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};

/** A promise that is settled by hand. */
function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => {
    d.resolve = resolve;
    d.reject = reject;
  });
  return d;
}

function makeClient(fetchFn, extra = {}) {
  return notion.createClient({ token: TOKEN, fetch: fetchFn, sleep: noSleep, ...extra });
}

/** A service over a fake fetch. `clock` is { t: <ms> }; move clock.t to move time. */
function makeService(fetchFn, { clock = { t: 0 }, today = WEDNESDAY, client } = {}) {
  return notion.createYarukoto({
    client: client || makeClient(fetchFn),
    dataSourceId: DATA_SOURCE_ID,
    now: () => clock.t,
    today: () => today,
  });
}

const fakeReq = ({ pageId, body } = {}) => ({ params: pageId === undefined ? {} : { pageId }, body });

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.set = (name, value) => {
    res.headers[name] = value;
    return res;
  };
  return res;
}

const rejection = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected the promise to reject');
};

// ---------------------------------------------------------------------------
// #1 The request that reads the list
// ---------------------------------------------------------------------------

describe('reading: the request sent to Notion', () => {
  // The filter for a read made on `day` (a Date, local time) in the week of `monday` ('YYYY-MM-DD').
  // The last-edited line is written out here on its own, from the local midnight of that day.
  const expectedFilter = (monday, day) => ({
    and: [
      { property: '種類', select: { equals: '1時間' } },
      {
        or: [
          { property: '済', checkbox: { equals: false } },
          { property: '予定週', date: { on_or_after: monday } },
          {
            timestamp: 'last_edited_time',
            last_edited_time: { on_or_after: new Date(day.getFullYear(), day.getMonth(), day.getDate()).toISOString() },
          },
        ],
      },
    ],
  });

  it('[#1] POST /v1/data_sources/<id>/query with the version, the token, the filter and page_size 100', async () => {
    const fetch = fakeFetch(queryResponse([]));
    await makeService(fetch).list();

    assert.equal(fetch.calls.length, 1);
    const [call] = fetch.calls;
    assert.equal(call.url, `https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['Notion-Version'], '2026-03-11');
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.deepEqual(call.body, { filter: expectedFilter(THIS_MONDAY, WEDNESDAY), page_size: 100 });
    assert.ok(call.signal, 'every request carries a timeout signal');
  });

  it('the filter keeps every unfinished row and the finished rows from this Monday on', () => {
    // Sunday still belongs to the week that began on the Monday before it
    for (const [day, monday] of [
      [new Date(2026, 9, 19, 0, 0, 0), '2026-10-19'], // Monday
      [new Date(2026, 9, 21, 23, 59, 59), '2026-10-19'], // Wednesday
      [new Date(2026, 9, 25, 12, 0, 0), '2026-10-19'], // Sunday
      [new Date(2026, 9, 26, 0, 0, 0), '2026-10-26'], // the next Monday
      [new Date(2026, 0, 1, 12, 0, 0), '2025-12-29'], // across the new year
    ]) {
      assert.equal(notion.mondayISO(day), monday, String(day));
      assert.deepEqual(notion.buildFilter(day), expectedFilter(monday, day), String(day));
    }
  });

  it('the Monday and the midnight in the filter follow the day of the read, not the day the server started', async () => {
    const fetch = fakeFetch(queryResponse([]), queryResponse([]));
    const clock = { t: 0 };
    let today = WEDNESDAY;
    const service = notion.createYarukoto({
      client: makeClient(fetch),
      dataSourceId: DATA_SOURCE_ID,
      now: () => clock.t,
      today: () => today,
    });
    await service.list();
    clock.t = 60 * 1000;
    today = new Date(2026, 9, 28, 9, 0, 0);
    await service.list();
    assert.equal(fetch.calls[0].body.filter.and[1].or[1].date.on_or_after, THIS_MONDAY);
    assert.equal(fetch.calls[1].body.filter.and[1].or[1].date.on_or_after, NEXT_MONDAY);
    assert.deepEqual(fetch.calls[0].body.filter, expectedFilter(THIS_MONDAY, WEDNESDAY));
    assert.deepEqual(fetch.calls[1].body.filter, expectedFilter(NEXT_MONDAY, new Date(2026, 9, 28)));
  });

  it('the base URL and the version can be set (a trailing slash on the base is ignored)', async () => {
    const fetch = fakeFetch(queryResponse([]));
    const client = makeClient(fetch, { apiBase: 'http://127.0.0.1:9999/', version: '2099-01-01' });
    await makeService(fetch, { client }).list();
    assert.equal(fetch.calls[0].url, `http://127.0.0.1:9999/v1/data_sources/${DATA_SOURCE_ID}/query`);
    assert.equal(fetch.calls[0].headers['Notion-Version'], '2099-01-01');
  });

  it('a client cannot be made without a token', () => {
    assert.throws(() => notion.createClient({ token: '', fetch: async () => {} }), TypeError);
    assert.throws(() => notion.createClient({ fetch: async () => {} }), TypeError);
  });
});

// ---------------------------------------------------------------------------
// #2 Paging
// ---------------------------------------------------------------------------

describe('reading: paging', () => {
  it('[#2] follows has_more / next_cursor and joins the pages of results into one list', async () => {
    const fetch = fakeFetch(
      queryResponse([notionPage(ID1, { title: 'a', week: THIS_MONDAY, priority: 1 })], 'cursor-1'),
      queryResponse([notionPage(ID2, { title: 'b', week: THIS_MONDAY, priority: 2 })])
    );
    const items = await makeService(fetch).list();

    assert.equal(fetch.calls.length, 2);
    assert.equal(fetch.calls[0].body.start_cursor, undefined, 'the first request has no cursor');
    assert.equal(fetch.calls[1].body.start_cursor, 'cursor-1');
    assert.equal(fetch.calls[1].url, fetch.calls[0].url);
    assert.deepEqual(fetch.calls[1].body.filter, fetch.calls[0].body.filter);
    assert.equal(fetch.calls[1].body.page_size, 100);
    assert.deepEqual(items.map((item) => item.id), [ID1, ID2]);
  });

  it('follows three pages, and a row that comes twice is kept once', async () => {
    const fetch = fakeFetch(
      queryResponse([notionPage(ID1, { title: 'a' })], 'c1'),
      queryResponse([notionPage(ID2, { title: 'b' }), notionPage(ID1, { title: 'a' })], 'c2'),
      queryResponse([notionPage(ID3, { title: 'c' })])
    );
    const items = await makeService(fetch).list();
    assert.equal(fetch.calls.length, 3);
    assert.deepEqual(items.map((item) => item.id).sort(), [ID1, ID2, ID3]);
  });

  it('has_more without a cursor, or a read that never ends, is an error (never a half list)', async () => {
    const noCursor = fakeFetch(ok({ results: [notionPage(ID1)], has_more: true, next_cursor: null }));
    const err = await rejection(makeService(noCursor).list());
    assert.equal(err.kind, 'failed');

    const endless = fakeFetch(...Array.from({ length: 80 }, () => () => queryResponse([], 'again')));
    const err2 = await rejection(makeService(endless).list());
    assert.equal(err2.kind, 'failed');
    assert.equal(endless.calls.length, 50, 'it gives up after 50 pages');
  });
});

// ---------------------------------------------------------------------------
// #3 Row conversion
// ---------------------------------------------------------------------------

describe('row conversion', () => {
  it('[#3] every column of a full page is converted to its type', () => {
    const page = notionPage(ID1, {
      title: 'GEO施策の記事を書く', done: true, business: 'Webサイト', project: 'GEO施策',
      week: THIS_MONDAY, priority: 3, criteria: '1本公開する', deadline: '2026-10-25',
      source: 'https://example.com/source', stale: '2週以上前から',
    });
    assert.deepEqual(notion.toItem(page), {
      id: ID1,
      url: `https://www.notion.so/${ID1.replace(/-/g, '')}`,
      title: 'GEO施策の記事を書く',
      done: true,
      weekStart: THIS_MONDAY,
      priority: 3,
      business: 'Webサイト',
      category: '事業',
      project: 'GEO施策',
      criteria: '1本公開する',
      deadline: '2026-10-25',
      source: 'https://example.com/source',
      stale: '2週以上前から',
      lastEdited: EDITED,
    });
  });

  it('[#3] title and rich text are made of several parts: their plain_text is joined', () => {
    const page = notionPage(ID1);
    page.properties['名前'].title = [{ plain_text: '前半' }, { plain_text: '・' }, { plain_text: '後半' }];
    page.properties['完了条件'].rich_text = [{ plain_text: '一行目\n' }, { plain_text: '二行目' }];
    const item = notion.toItem(page);
    assert.equal(item.title, '前半・後半');
    assert.equal(item.criteria, '一行目\n二行目');
  });

  it('[#3] a priority of 0 is a number (not "empty"); a negative or decimal one is kept too', () => {
    assert.equal(notion.toItem(notionPage(ID1, { priority: 0 })).priority, 0);
    assert.equal(notion.toItem(notionPage(ID1, { priority: -2 })).priority, -2);
    assert.equal(notion.toItem(notionPage(ID1, { priority: 1.5 })).priority, 1.5);
  });

  it('[#3] a date that carries a time keeps only the YYYY-MM-DD part', () => {
    const page = notionPage(ID1, { week: '2026-10-19T00:00:00.000+09:00', deadline: '2026-10-25T18:30:00.000-05:00' });
    const item = notion.toItem(page);
    assert.equal(item.weekStart, '2026-10-19');
    assert.equal(item.deadline, '2026-10-25');
  });

  it('[#3] an unfinished empty row: no week, no priority, nothing else -> null / false', () => {
    const item = notion.toItem(notionPage(ID1, { title: 'x' }));
    assert.equal(item.done, false);
    assert.equal(item.weekStart, null);
    assert.equal(item.priority, null);
    assert.equal(item.business, null);
    assert.equal(item.project, null);
    assert.equal(item.criteria, null);
    assert.equal(item.deadline, null);
    assert.equal(item.source, null);
    assert.equal(item.stale, null, 'a formula that gives an empty text is no badge');
    assert.equal(item.category, 'その他');
  });

  it('[#3] a formula that is unsupported, or not a text, gives null', () => {
    for (const formula of [
      { type: 'unsupported' },
      { type: 'number', number: 3 },
      { type: 'boolean', boolean: true },
      { type: 'string', string: null },
      { type: 'string' },
      null,
      'text',
    ]) {
      const page = notionPage(ID1);
      page.properties['滞留'] = { type: 'formula', formula };
      assert.equal(notion.toItem(page).stale, null, JSON.stringify(formula));
    }
    const page = notionPage(ID1);
    page.properties['滞留'] = { type: 'unsupported' };
    assert.equal(notion.toItem(page).stale, null);
  });

  it('[#3] columns that are missing give null / false / an empty title, and nothing throws', () => {
    const bare = notion.toItem({ id: ID1, properties: {} });
    assert.deepEqual(bare, {
      id: ID1, url: null, title: '', done: false, weekStart: null, priority: null, business: null,
      category: 'その他', project: null, criteria: null, deadline: null, source: null, stale: null, lastEdited: null,
    });

    // only the title, written by the user in Notion
    const onlyTitle = notion.toItem({ id: ID1, properties: { 名前: { title: richText('だけ') } } });
    assert.equal(onlyTitle.title, 'だけ');
    assert.equal(onlyTitle.priority, null);
  });

  it('[#3] a partial page (no `properties` at all, or not an object) is skipped, whatever else it has', () => {
    for (const properties of [undefined, null, [], 'x', 7, true]) {
      const page = { object: 'page', id: ID1, last_edited_time: EDITED, url: 'https://www.notion.so/x', properties };
      assert.doesNotThrow(() => notion.toItem(page), JSON.stringify(properties));
      assert.equal(notion.toItem(page), null, JSON.stringify(properties));
    }
    const noKey = { object: 'page', id: ID1, last_edited_time: EDITED };
    assert.equal(notion.toItem(noKey), null);
  });

  it('[#3] the list leaves partial pages out and keeps the whole pages around them', async () => {
    const fetch = fakeFetch(
      queryResponse([
        notionPage(ID1, { title: 'a', week: THIS_MONDAY, priority: 1 }),
        { object: 'page', id: ID3, last_edited_time: EDITED }, // partial: no properties
        notionPage(ID2, { title: 'b', week: THIS_MONDAY, priority: 2 }),
      ])
    );
    const items = await makeService(fetch).list();
    assert.deepEqual(items.map((item) => item.id), [ID1, ID2]);
  });

  it('[#3] columns of an unexpected type give null / false and nothing throws', () => {
    const page = {
      id: ID1,
      url: 12345,
      properties: {
        名前: { title: 'not an array' },
        済: { checkbox: 'yes' },
        事業: { select: 'Webサイト' },
        プロジェクト: { select: { name: 7 } },
        予定週: { date: 'next week' },
        優先: { number: '3' },
        完了条件: { rich_text: 'text' },
        締切: { date: { start: 'someday' } },
        出典: { url: { href: 'x' } },
        滞留: { formula: { type: 'string', string: 5 } },
      },
    };
    let item;
    assert.doesNotThrow(() => {
      item = notion.toItem(page);
    });
    assert.deepEqual(item, {
      id: ID1, url: null, title: '', done: false, weekStart: null, priority: null, business: null,
      category: 'その他', project: null, criteria: null, deadline: null, source: null, stale: null, lastEdited: null,
    });
    assert.equal(notion.toItem({ id: ID1, properties: { 優先: { number: NaN } } }).priority, null);
  });

  it('something that is not a page (no id) is not a row', () => {
    for (const value of [null, undefined, {}, { id: 5 }, { id: '' }, 'text', []]) {
      assert.equal(notion.toItem(value), null, JSON.stringify(value));
    }
  });
});

// ---------------------------------------------------------------------------
// #11 The read condition has "last edited today"
// ---------------------------------------------------------------------------

describe('reading: rows edited today', () => {
  // How many levels of and / or are nested inside each other (Notion takes two).
  const compoundDepth = (filter) => {
    const inner = filter.and || filter.or;
    return inner ? 1 + Math.max(0, ...inner.map(compoundDepth)) : 0;
  };

  it('[#11] the body of the read has a last_edited_time condition in the `or`, from the local midnight of the day, in UTC', async () => {
    const fetch = fakeFetch(queryResponse([]));
    await makeService(fetch).list();

    const filter = fetch.calls[0].body.filter;
    const lastEdited = filter.and[1].or.find((condition) => condition.timestamp === 'last_edited_time');
    assert.deepEqual(lastEdited, {
      timestamp: 'last_edited_time',
      last_edited_time: { on_or_after: new Date(2026, 9, 21).toISOString() },
    });
    // the other two conditions are still there, beside it
    assert.deepEqual(filter.and[1].or.length, 3);
    assert.deepEqual(filter.and[1].or[0], { property: '済', checkbox: { equals: false } });
    assert.deepEqual(filter.and[1].or[1], { property: '予定週', date: { on_or_after: THIS_MONDAY } });
    assert.deepEqual(filter.and[0], { property: '種類', select: { equals: '1時間' } });
  });

  it('[#11] it has no `property` key (Notion refuses one), and the value ends in Z with no offset', async () => {
    const fetch = fakeFetch(queryResponse([]));
    await makeService(fetch).list();
    const condition = fetch.calls[0].body.filter.and[1].or[2];
    assert.equal('property' in condition, false);
    assert.deepEqual(Object.keys(condition).sort(), ['last_edited_time', 'timestamp']);
    assert.match(condition.last_edited_time.on_or_after, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('[#11] the value is exactly midnight (0:00:00.000) of the read\'s day in the server\'s local time', () => {
    for (const day of [
      new Date(2026, 9, 21, 0, 0, 0, 0),
      new Date(2026, 9, 21, 12, 34, 56, 789),
      new Date(2026, 9, 21, 23, 59, 59, 999),
      new Date(2026, 0, 1, 0, 0, 0, 1),
      new Date(2026, 11, 31, 23, 59, 59, 999),
    ]) {
      const start = new Date(notion.startOfDayISO(day));
      assert.equal(start.getFullYear(), day.getFullYear(), String(day));
      assert.equal(start.getMonth(), day.getMonth(), String(day));
      assert.equal(start.getDate(), day.getDate(), String(day));
      assert.deepEqual([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()], [0, 0, 0, 0], String(day));
      assert.match(notion.startOfDayISO(day), /Z$/);
    }
  });

  it('[#11] Japan time: 0:00 on 10/20 is "2026-10-19T15:00:00.000Z" (the example in the brief)', { skip: new Date(2026, 9, 20).getTimezoneOffset() !== -540 && 'this machine is not on Japan time' }, () => {
    assert.equal(notion.startOfDayISO(new Date(2026, 9, 20, 15, 30)), '2026-10-19T15:00:00.000Z');
  });

  it('[#11] it is still two levels of and / or at most', () => {
    assert.equal(compoundDepth(notion.buildFilter(WEDNESDAY)), 2);
  });

  it('[#11] the condition follows the day of each read', async () => {
    const fetch = fakeFetch(queryResponse([]), queryResponse([]));
    const clock = { t: 0 };
    let today = WEDNESDAY;
    const service = notion.createYarukoto({
      client: makeClient(fetch),
      dataSourceId: DATA_SOURCE_ID,
      now: () => clock.t,
      today: () => today,
    });
    await service.list();
    clock.t = 60 * 1000;
    today = new Date(2026, 9, 22, 8, 0, 0);
    await service.list();
    const since = (call) => call.body.filter.and[1].or[2].last_edited_time.on_or_after;
    assert.equal(since(fetch.calls[0]), new Date(2026, 9, 21).toISOString());
    assert.equal(since(fetch.calls[1]), new Date(2026, 9, 22).toISOString());
  });
});

describe('row conversion: lastEdited', () => {
  it('[#12] lastEdited is the page\'s last_edited_time, as the text it came in', () => {
    for (const text of ['2026-10-20T08:15:30.123Z', '2020-03-17T19:10:04.968Z', '2026-10-20T17:15:30.000+09:00']) {
      assert.equal(notion.toItem(notionPage(ID1, { lastEdited: text })).lastEdited, text);
    }
  });

  it('[#12] it is null when the page has no last_edited_time, or it is not a text', () => {
    assert.equal(notion.toItem(notionPage(ID1, { lastEdited: null })).lastEdited, null);
    for (const value of [undefined, null, '', 0, 1760000000000, {}, [], true]) {
      const page = notionPage(ID1);
      page.last_edited_time = value;
      assert.equal(notion.toItem(page).lastEdited, null, JSON.stringify(value));
    }
  });

  it('[#12] it comes through the list to the screen', async () => {
    const fetch = fakeFetch(
      queryResponse([
        notionPage(ID1, { title: 'a', week: THIS_MONDAY, priority: 1, lastEdited: '2026-10-21T01:00:00.000Z' }),
        notionPage(ID2, { title: 'b', week: THIS_MONDAY, priority: 2, lastEdited: null }),
      ])
    );
    const items = await makeService(fetch).list();
    assert.deepEqual(items.map((item) => item.lastEdited), ['2026-10-21T01:00:00.000Z', null]);
  });
});

// ---------------------------------------------------------------------------
// #4 Order
// ---------------------------------------------------------------------------

describe('order', () => {
  const row = (id, weekStart, priority, title) => ({ id, weekStart, priority, title });

  it('[#4] earlier week first, no week last; then smaller 優先 first, none last; then title', () => {
    const rows = [
      row('later-none-b', null, null, 'b'),
      row('next-1', NEXT_MONDAY, 1, 'z'),
      row('later-1', null, 1, 'z'),
      row('this-none', THIS_MONDAY, null, 'a'),
      row('this-5', THIS_MONDAY, 5, 'a'),
      row('past-9', LAST_MONDAY, 9, 'a'),
      row('later-none-a', null, null, 'a'),
      row('this-2', THIS_MONDAY, 2, 'a'),
    ];
    assert.deepEqual(notion.sortItems(rows).map((r) => r.id), [
      'past-9', 'this-2', 'this-5', 'this-none', 'next-1', 'later-1', 'later-none-a', 'later-none-b',
    ]);
  });

  it('[#4] the same week and the same 優先: by title; priority 0 comes before 1 (0 is a value, not empty)', () => {
    const rows = [
      row('c', THIS_MONDAY, 1, 'いろは'),
      row('a', THIS_MONDAY, 1, 'Apple'),
      row('b', THIS_MONDAY, 1, 'Banana'),
      row('zero', THIS_MONDAY, 0, 'zzz'),
    ];
    assert.deepEqual(notion.sortItems(rows).map((r) => r.id), ['zero', 'a', 'b', 'c']);
  });

  it('[#4] does not change the array it is given', () => {
    const rows = [row('b', NEXT_MONDAY, 1, 'b'), row('a', THIS_MONDAY, 1, 'a')];
    const before = rows.map((r) => r.id);
    notion.sortItems(rows);
    assert.deepEqual(rows.map((r) => r.id), before);
  });

  it('[#4] list() hands the rows over in that order, whatever order Notion sent them in', async () => {
    const fetch = fakeFetch(
      queryResponse([
        notionPage(ID1, { title: 'later', week: null, priority: 1 }),
        notionPage(ID2, { title: 'next', week: NEXT_MONDAY, priority: 1 }),
        notionPage(ID3, { title: 'this', week: THIS_MONDAY, priority: 9 }),
      ])
    );
    const items = await makeService(fetch).list();
    assert.deepEqual(items.map((item) => item.title), ['this', 'next', 'later']);
  });
});

// ---------------------------------------------------------------------------
// #5 Categories
// ---------------------------------------------------------------------------

describe('categories', () => {
  const cases = [
    // [事業, name, category]
    ['YCDC', '何か', 'YCDC'],
    ['株', '何か', '株'],
    ['Webサイト', '何か', '事業'],
    ['自動収入', '何か', '事業'],
    ['事務', '何か', 'マネジメント'],
    ['その他', '何か', 'その他'],
    ['その他', '会社化の準備をする', 'マネジメント'],
    ['その他', 'Aを会社化する件', 'マネジメント'],
    [null, '何か', 'その他'],
    [null, '会社化', 'マネジメント'],
    // the 会社化 rule is only for その他 and an empty column
    ['YCDC', '会社化', 'YCDC'],
    ['株', '会社化', '株'],
    ['Webサイト', '会社化', '事業'],
    ['自動収入', '会社化', '事業'],
    ['事務', '会社化', 'マネジメント'],
    // an option that is added to the column later is treated like その他
    ['プライベート', '何か', 'その他'],
    ['プライベート', '会社化', 'マネジメント'],
  ];

  for (const [business, title, category] of cases) {
    it(`[#5] 事業 ${business === null ? '(empty)' : business} / "${title}" -> ${category}`, () => {
      assert.equal(notion.categoryOf(business, title), category);
      const item = notion.toItem(notionPage(ID1, { title, business }));
      assert.equal(item.category, category);
      assert.equal(item.business, business, 'the original column value is kept next to the category');
    });
  }

  it('[#5] a title that is not a string does not break the rule', () => {
    assert.equal(notion.categoryOf('その他', undefined), 'その他');
    assert.equal(notion.categoryOf(null, null), 'その他');
  });
});

// ---------------------------------------------------------------------------
// #6 The write
// ---------------------------------------------------------------------------

describe('writing 済', () => {
  it('[#6] PATCH /v1/pages/<id> with { properties: { 済: { checkbox: true } } }', async () => {
    const fetch = fakeFetch(queryResponse([notionPage(ID1)]), updateResponse(ID1));
    const result = await makeService(fetch).setDone(ID1, true);

    assert.deepEqual(result, { id: ID1, done: true });
    assert.equal(fetch.calls.length, 2, 'one read to find the row, one write');
    const call = fetch.calls[1];
    assert.equal(call.url, `https://api.notion.com/v1/pages/${ID1}`);
    assert.equal(call.method, 'PATCH');
    assert.equal(call.headers['Notion-Version'], '2026-03-11');
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.deepEqual(call.body, { properties: { 済: { checkbox: true } } });
  });

  it('[#6] done: false sends checkbox false', async () => {
    const fetch = fakeFetch(queryResponse([notionPage(ID1, { done: true, week: THIS_MONDAY })]), updateResponse(ID1));
    const result = await makeService(fetch).setDone(ID1, false);
    assert.deepEqual(result, { id: ID1, done: false });
    assert.deepEqual(fetch.calls[1].body, { properties: { 済: { checkbox: false } } });
  });

  it('the row is found with or without hyphens and in any case; the write uses the id Notion gave', async () => {
    for (const written of [ID2.replace(/-/g, ''), ID2.toUpperCase()]) {
      const fetch = fakeFetch(queryResponse([notionPage(ID1), notionPage(ID2)]), updateResponse(ID2));
      const result = await makeService(fetch).setDone(written, true);
      assert.equal(result.id, ID2);
      assert.equal(fetch.calls[1].url, `https://api.notion.com/v1/pages/${ID2}`);
    }
  });

  it('a Notion error on the write is an error of the caller, and the remembered list is dropped anyway', async () => {
    const fetch = fakeFetch(
      queryResponse([notionPage(ID1)]),
      failure(400, { object: 'error', code: 'validation_error', message: 'Could not find property 済' }),
      queryResponse([notionPage(ID1)])
    );
    const service = makeService(fetch);
    const err = await rejection(service.setDone(ID1, true));
    assert.equal(err.kind, 'failed');
    assert.equal(err.status, 400);
    assert.match(err.message, /HTTP 400 validation_error/);
    await service.list();
    assert.equal(fetch.calls.length, 3, 'the next list is read again');
  });
});

// ---------------------------------------------------------------------------
// #7 429 / 529 and Retry-After
// ---------------------------------------------------------------------------

describe('busy: 429 and 529', () => {
  const busy = (status, retryAfter) =>
    failure(status, { object: 'error', code: 'rate_limited', message: 'slow down' }, retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) });

  it('[#7] 429 with Retry-After: 1 -> waits 1 second, tries once more, and the second answer is used', async () => {
    const slept = [];
    const fetch = fakeFetch(busy(429, 1), queryResponse([notionPage(ID1)]));
    const client = makeClient(fetch, { sleep: async (ms) => slept.push(ms) });
    const items = await makeService(fetch, { client }).list();

    assert.equal(fetch.calls.length, 2);
    assert.deepEqual(slept, [1000]);
    assert.equal(items.length, 1);
    assert.deepEqual(fetch.calls[1].body, fetch.calls[0].body, 'the retry sends the same request');
  });

  it('[#7] 429 with Retry-After: 30 -> no retry, no wait: a busy error', async () => {
    const slept = [];
    const fetch = fakeFetch(busy(429, 30), queryResponse([]));
    const client = makeClient(fetch, { sleep: async (ms) => slept.push(ms) });
    const err = await rejection(makeService(fetch, { client }).list());

    assert.equal(err.kind, 'busy');
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(slept, []);
  });

  it('[#7] the limit is 5 seconds: 5 is waited for, 6 is not, and so is a missing or odd header', async () => {
    for (const [retryAfter, retried] of [[0, true], [5, true], [5.5, false], [6, false], [undefined, false], ['soon', false]]) {
      const fetch = fakeFetch(busy(429, retryAfter), queryResponse([]));
      const outcome = await makeService(fetch).list().then(() => 'read', (err) => err.kind);
      assert.equal(outcome, retried ? 'read' : 'busy', `Retry-After ${retryAfter}`);
      assert.equal(fetch.calls.length, retried ? 2 : 1, `Retry-After ${retryAfter}`);
    }
  });

  it('[#7] a second 429 after the retry is a busy error, and there is no third try', async () => {
    const fetch = fakeFetch(busy(429, 1), busy(429, 1), queryResponse([]));
    const err = await rejection(makeService(fetch).list());
    assert.equal(err.kind, 'busy');
    assert.equal(fetch.calls.length, 2);
  });

  it('[#7] 529 is treated like 429', async () => {
    const fetch1 = fakeFetch(busy(529, 1), queryResponse([notionPage(ID1)]));
    assert.equal((await makeService(fetch1).list()).length, 1);
    assert.equal(fetch1.calls.length, 2);

    const fetch2 = fakeFetch(busy(529, 30));
    assert.equal((await rejection(makeService(fetch2).list())).kind, 'busy');
    assert.equal(fetch2.calls.length, 1);
  });

  it('[#7] the write is retried the same way', async () => {
    const fetch = fakeFetch(queryResponse([notionPage(ID1)]), busy(429, 1), updateResponse(ID1));
    const result = await makeService(fetch).setDone(ID1, true);
    assert.deepEqual(result, { id: ID1, done: true });
    assert.equal(fetch.calls.length, 3);
    assert.equal(fetch.calls[2].method, 'PATCH');

    const fetch2 = fakeFetch(queryResponse([notionPage(ID1)]), busy(429, 60));
    assert.equal((await rejection(makeService(fetch2).setDone(ID1, true))).kind, 'busy');
    assert.equal(fetch2.calls.length, 2);
  });

  it('each page of a long read gets its own retry', async () => {
    const fetch = fakeFetch(
      queryResponse([notionPage(ID1)], 'c1'),
      busy(429, 1),
      queryResponse([notionPage(ID2)], 'c2'),
      busy(429, 1),
      queryResponse([notionPage(ID3)])
    );
    assert.equal((await makeService(fetch).list()).length, 3);
    assert.equal(fetch.calls.length, 5);
  });

  it('after the retry, a 500 is a plain failure (not "busy")', async () => {
    const fetch = fakeFetch(busy(429, 1), failure(500, { code: 'internal_server_error' }));
    const err = await rejection(makeService(fetch).list());
    assert.equal(err.kind, 'failed');
    assert.equal(err.status, 500);
  });
});

describe('other failures', () => {
  it('a non-2xx answer is a failure that says the status and the code', async () => {
    const fetch = fakeFetch(failure(401, { object: 'error', code: 'unauthorized', message: 'API token is invalid.' }));
    const err = await rejection(makeService(fetch).list());
    assert.equal(err.kind, 'failed');
    assert.equal(err.status, 401);
    assert.match(err.message, /HTTP 401 unauthorized/);
  });

  it('an answer that is not JSON, and a fetch that throws, are failures', async () => {
    const html = fakeFetch(new Response('<html>oops</html>', { status: 200 }));
    assert.equal((await rejection(makeService(html).list())).kind, 'failed');

    const htmlError = fakeFetch(new Response('<html>bad gateway</html>', { status: 502 }));
    assert.equal((await rejection(makeService(htmlError).list())).kind, 'failed');

    const down = fakeFetch(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    const err = await rejection(makeService(down).list());
    assert.equal(err.kind, 'failed');
    assert.match(err.message, /TypeError \(ECONNREFUSED\)/);
  });

  it('a request that does not answer is given up on after the timeout', async () => {
    const hang = (call) =>
      new Promise((resolve, reject) => {
        call.signal.addEventListener('abort', () => reject(call.signal.reason));
      });
    const fetch = fakeFetch(hang);
    const client = makeClient(fetch, { timeoutMs: 30 });
    const err = await rejection(makeService(fetch, { client }).list());
    assert.equal(err.kind, 'failed');
    assert.match(err.message, /TimeoutError/);
  });
});

// ---------------------------------------------------------------------------
// #8 The token never shows up in an error text, a log line or a response
// ---------------------------------------------------------------------------

describe('the token stays secret', () => {
  const everythingAbout = (err) => JSON.stringify([err.message, String(err), err.stack, err.kind, err.status]);

  it('[#8] a fetch error that carries the token in its message or cause does not put it in ours', async () => {
    const leaky = Object.assign(new Error(`connect failed, sent Authorization: Bearer ${TOKEN}`), {
      cause: { code: `E_${TOKEN}`, message: TOKEN },
    });
    const err = await rejection(makeService(fakeFetch(leaky)).list());
    assert.equal(err.kind, 'failed');
    assert.ok(!everythingAbout(err).includes(TOKEN), everythingAbout(err));
  });

  it('[#8] a Notion error body that echoes the token is cut before it is kept', async () => {
    const fetch = fakeFetch(
      failure(401, { object: 'error', code: 'unauthorized', message: `Bearer ${TOKEN} is not valid, token ${TOKEN}` })
    );
    const err = await rejection(makeService(fetch).list());
    assert.equal(err.kind, 'failed');
    assert.ok(!everythingAbout(err).includes(TOKEN), everythingAbout(err));
    assert.match(err.message, /\[redacted\]/);
    assert.match(err.message, /HTTP 401 unauthorized/);
  });

  it('[#8] a busy error carries no token either', async () => {
    const fetch = fakeFetch(failure(429, { message: TOKEN }, { 'Retry-After': '60' }));
    const err = await rejection(makeService(fetch).list());
    assert.equal(err.kind, 'busy');
    assert.ok(!everythingAbout(err).includes(TOKEN));
  });

  it('[#8] through the routes: the answers and the log lines never hold the token or the Authorization header', async () => {
    const logged = [];
    const responses = [];
    const steps = [
      // GET: fetch throws, and says the header it sent
      Object.assign(new Error(`boom, sent Authorization: Bearer ${TOKEN}`), { cause: { code: TOKEN } }),
      failure(500, { code: 'internal_server_error', message: `token ${TOKEN}` }), // GET: Notion 500
      failure(429, { message: `token ${TOKEN}` }, { 'Retry-After': '99' }), // GET: busy
      queryResponse([notionPage(ID1)]), // PATCH: read
      failure(400, { code: 'validation_error', message: `bad token ${TOKEN}` }), // PATCH: Notion 400
    ];
    const clock = { t: 0 };
    const service = makeService(fakeFetch(...steps), { clock });
    const routes = notion.createRoutes(service, { log: (...args) => logged.push(args.join(' ')) });

    for (let i = 0; i < 3; i += 1) {
      const res = fakeRes();
      await routes.list(fakeReq(), res);
      responses.push(res);
    }
    const res4 = fakeRes();
    await routes.update(fakeReq({ pageId: ID1, body: { done: true } }), res4);
    responses.push(res4);

    assert.deepEqual(responses.map((res) => res.statusCode), [502, 502, 503, 502]);
    const everything = JSON.stringify([logged, responses.map((res) => [res.statusCode, res.body, res.headers])]);
    assert.ok(!everything.includes(TOKEN), everything);
    assert.ok(!/bearer/i.test(everything), everything);
    assert.ok(!/authorization/i.test(everything), everything);
    assert.equal(logged.length, 4, 'each failure leaves one line in the log');
  });

  it('[#8] the rows handed to the screen do not contain the token', async () => {
    const fetch = fakeFetch(queryResponse([notionPage(ID1, { title: 'a', business: 'YCDC' })]));
    const items = await makeService(fetch).list();
    assert.ok(!JSON.stringify(items).includes(TOKEN));
  });
});

// ---------------------------------------------------------------------------
// #9 An id that is not in the list is never sent to Notion; the 15-second memory
// ---------------------------------------------------------------------------

describe('the list in memory and the id check', () => {
  it('[#9] an id that is not in the list: "not found", and Notion is not asked to change anything', async () => {
    const fetch = fakeFetch(queryResponse([notionPage(ID1)]));
    const service = makeService(fetch);
    const err = await rejection(service.setDone(ID3, true));

    assert.equal(err.kind, 'not_found');
    assert.equal(fetch.calls.length, 1, 'only the read');
    assert.equal(fetch.calls[0].method, 'POST');
  });

  it('[#9] the route answers 404 for it, and Notion sees no write', async () => {
    const fetch = fakeFetch(queryResponse([notionPage(ID1)]));
    const routes = notion.createRoutes(makeService(fetch), { log: () => {} });
    const res = fakeRes();
    await routes.update(fakeReq({ pageId: ID3, body: { done: true } }), res);

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Not found' });
    assert.ok(fetch.calls.every((call) => call.method !== 'PATCH'));
  });

  it('[#9] a page of another database (an id Notion did not return) is never written, however it is written', async () => {
    const otherPage = '11111111-2222-4333-8444-555555555555';
    for (const attempt of [otherPage, otherPage.replace(/-/g, ''), otherPage.toUpperCase()]) {
      const fetch = fakeFetch(queryResponse([notionPage(ID1)]));
      const err = await rejection(makeService(fetch).setDone(attempt, true));
      assert.equal(err.kind, 'not_found', attempt);
      assert.deepEqual(fetch.calls.map((call) => call.method), ['POST'], attempt);
    }
  });

  it('two reads less than 15 seconds apart are one Notion call; at 15 seconds the list is read again', async () => {
    const clock = { t: 1000 };
    const fetch = fakeFetch(queryResponse([notionPage(ID1)]), queryResponse([notionPage(ID1), notionPage(ID2)]));
    const service = makeService(fetch, { clock });

    assert.equal((await service.list()).length, 1);
    clock.t = 1000 + 14999;
    assert.equal((await service.list()).length, 1);
    assert.equal(fetch.calls.length, 1);

    clock.t = 1000 + 15000;
    assert.equal((await service.list()).length, 2);
    assert.equal(fetch.calls.length, 2);
  });

  it('a row judged within 15 seconds of the last read is judged on that list, without asking Notion again', async () => {
    const clock = { t: 0 };
    const fetch = fakeFetch(queryResponse([notionPage(ID1)]));
    const service = makeService(fetch, { clock });
    await service.list();
    clock.t = 10000;
    assert.equal((await rejection(service.setDone(ID2, true))).kind, 'not_found');
    assert.equal(fetch.calls.length, 1);
  });

  it('when the memory has run out, the list is read again BEFORE the id is judged (a row added on another device)', async () => {
    const clock = { t: 0 };
    const fetch = fakeFetch(
      queryResponse([notionPage(ID1)]), // the screen's list
      queryResponse([notionPage(ID1), notionPage(ID2)]), // read again when the write arrives
      updateResponse(ID2)
    );
    const service = makeService(fetch, { clock });
    await service.list();
    clock.t = 20000;
    const result = await service.setDone(ID2, true);

    assert.deepEqual(result, { id: ID2, done: true });
    assert.deepEqual(fetch.calls.map((call) => call.method), ['POST', 'POST', 'PATCH']);
  });

  it('a write drops the memory: the next list is read from Notion again', async () => {
    const clock = { t: 0 };
    const fetch = fakeFetch(
      queryResponse([notionPage(ID1)]),
      updateResponse(ID1),
      queryResponse([notionPage(ID1, { done: true, week: THIS_MONDAY })])
    );
    const service = makeService(fetch, { clock });
    await service.list();
    await service.setDone(ID1, true);
    const items = await service.list();

    assert.equal(fetch.calls.length, 3);
    assert.equal(items[0].done, true);
  });

  it('requests that arrive together while the list is being read share that one read', async () => {
    const gate = deferred();
    const fetch = fakeFetch(async () => {
      await gate.promise;
      return queryResponse([notionPage(ID1)]);
    });
    const service = makeService(fetch);
    const pending = [service.list(), service.list(), service.list()];
    gate.resolve();
    const results = await Promise.all(pending);

    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(results.map((items) => items.length), [1, 1, 1]);
  });

  it('a failed read is not remembered: the next list tries Notion again', async () => {
    const fetch = fakeFetch(failure(500), queryResponse([notionPage(ID1)]));
    const service = makeService(fetch);
    assert.equal((await rejection(service.list())).kind, 'failed');
    assert.equal((await service.list()).length, 1);
    assert.equal(fetch.calls.length, 2);
  });

  it('a read that began before a write is not remembered (it may hold the old 済)', async () => {
    const clock = { t: 0 };
    const writeGate = deferred();
    const readGate = deferred();
    const fetch = fakeFetch(
      queryResponse([notionPage(ID1)]), // 1: first list
      async () => {
        await writeGate.promise; // 2: the write, held back
        return updateResponse(ID1);
      },
      async () => {
        await readGate.promise; // 3: a read that begins while the write is under way
        return queryResponse([notionPage(ID1, { done: false })]);
      },
      queryResponse([notionPage(ID1, { done: true, week: THIS_MONDAY })]) // 4: the read after both
    );
    const service = makeService(fetch, { clock });

    await service.list(); // t = 0
    clock.t = 14900;
    const write = service.setDone(ID1, true); // judged on the list of t = 0, then held at the PATCH
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetch.calls.length, 2);

    clock.t = 15100; // the memory has run out: this list is a new read
    const read = service.list();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetch.calls.length, 3);

    writeGate.resolve(); // the write completes first ...
    await write;
    readGate.resolve(); // ... then the old read comes back
    const staleItems = await read;
    assert.equal(staleItems[0].done, false);

    const fresh = await service.list(); // it must not be served from the old read
    assert.equal(fetch.calls.length, 4);
    assert.equal(fresh[0].done, true);
  });
});

// ---------------------------------------------------------------------------
// #10 A row that was set to done leaves the list, but can be set back for an hour
// ---------------------------------------------------------------------------

describe('a row that left the list can be set back within an hour of the last list that had it', () => {
  const HOUR = 60 * 60 * 1000;

  it('[#10] a 後で row is set to done; the lists read after that no longer have it; it can still be set back to not done', async () => {
    // A row with no week matches the read condition only while it is not done, so once it is done
    // the next list does not have it (the second query below answers with nothing).
    const fetch = fakeFetch(
      queryResponse([notionPage(ID1, { title: '後での作業' })]), // 1: the screen's list
      updateResponse(ID1), // 2: set to done
      queryResponse([]), // 3: the list read afterwards: the row is gone
      updateResponse(ID1) // 4: set back to not done
    );
    const clock = { t: 0 };
    const service = makeService(fetch, { clock });

    assert.equal((await service.list()).length, 1);
    assert.deepEqual(await service.setDone(ID1, true), { id: ID1, done: true });

    clock.t = 60 * 1000;
    assert.equal((await service.list()).length, 0, 'the row has left the list');
    clock.t = 5 * 60 * 1000;
    assert.deepEqual(await service.setDone(ID1, false), { id: ID1, done: false });

    assert.deepEqual(fetch.calls.map((call) => call.method), ['POST', 'PATCH', 'POST', 'PATCH']);
    assert.equal(fetch.calls[1].url, `https://api.notion.com/v1/pages/${ID1}`);
    assert.deepEqual(fetch.calls[1].body, { properties: { 済: { checkbox: true } } });
    assert.equal(fetch.calls[3].url, `https://api.notion.com/v1/pages/${ID1}`);
    assert.deepEqual(fetch.calls[3].body, { properties: { 済: { checkbox: false } } });
  });

  it('[#10] set back right after it was set to done (before any list is read again): no read is needed', async () => {
    const fetch = fakeFetch(queryResponse([notionPage(ID1)]), updateResponse(ID1), updateResponse(ID1));
    const service = makeService(fetch);
    await service.list();
    await service.setDone(ID1, true);
    await service.setDone(ID1, false);
    assert.deepEqual(fetch.calls.map((call) => call.method), ['POST', 'PATCH', 'PATCH']);
  });

  it('[#10] the route answers 200 { id, done: false } for it', async () => {
    const fetch = fakeFetch(queryResponse([notionPage(ID1)]), updateResponse(ID1), queryResponse([]), updateResponse(ID1));
    const clock = { t: 0 };
    const service = makeService(fetch, { clock });
    const routes = notion.createRoutes(service, { log: () => {} });

    await routes.list(fakeReq(), fakeRes());
    const checked = fakeRes();
    await routes.update(fakeReq({ pageId: ID1, body: { done: true } }), checked);
    assert.equal(checked.statusCode, 200);

    clock.t = 30 * 1000;
    const reloaded = fakeRes();
    await routes.list(fakeReq(), reloaded);
    assert.deepEqual(reloaded.body.items, [], 'the screen no longer gets the row');

    const unchecked = fakeRes();
    await routes.update(fakeReq({ pageId: ID1.replace(/-/g, '').toUpperCase(), body: { done: false } }), unchecked);
    assert.equal(unchecked.statusCode, 200);
    assert.deepEqual(unchecked.body, { id: ID1, done: false });
    assert.equal(fetch.calls.at(-1).method, 'PATCH');
  });

  it('[#10] more than an hour after the last list that had it, the id is "not found" and nothing is written', async () => {
    const fetch = fakeFetch(
      queryResponse([notionPage(ID1)]), // t = 0: the list that returns the row
      queryResponse([]) // read again when the id is looked for: the row is not in it
    );
    const clock = { t: 0 };
    const service = makeService(fetch, { clock });
    await service.list();

    clock.t = HOUR + 1;
    const err = await rejection(service.setDone(ID1, true));
    assert.equal(err.kind, 'not_found');
    assert.deepEqual(fetch.calls.map((call) => call.method), ['POST', 'POST'], 'the list was read again, nothing was written');
  });

  it('[#10] the route answers 404 for it', async () => {
    const fetch = fakeFetch(queryResponse([notionPage(ID1)]), queryResponse([]));
    const clock = { t: 0 };
    const routes = notion.createRoutes(makeService(fetch, { clock }), { log: () => {} });
    await routes.list(fakeReq(), fakeRes());

    clock.t = 2 * HOUR;
    const res = fakeRes();
    await routes.update(fakeReq({ pageId: ID1, body: { done: false } }), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Not found' });
    assert.ok(fetch.calls.every((call) => call.method !== 'PATCH'));
  });

  it('[#10] the limit: just under an hour and exactly an hour are allowed, one millisecond more is not', async () => {
    const outcomes = [];
    for (const age of [HOUR - 1, HOUR, HOUR + 1]) {
      const fetch = fakeFetch(queryResponse([notionPage(ID1)]), age <= HOUR ? updateResponse(ID1) : queryResponse([]));
      const clock = { t: 0 };
      const service = makeService(fetch, { clock });
      await service.list();
      clock.t = age;
      outcomes.push(await service.setDone(ID1, true).then(() => 'written', (err) => err.kind));
    }
    assert.deepEqual(outcomes, ['written', 'written', 'not_found']);
  });

  it('[#10] a later list that still has the row starts the hour again', async () => {
    const fetch = fakeFetch(
      queryResponse([notionPage(ID1)]), // t = 0
      queryResponse([notionPage(ID1)]), // t = 50 min: the screen is reloaded, the row is still there
      updateResponse(ID1)
    );
    const clock = { t: 0 };
    const service = makeService(fetch, { clock });
    await service.list();
    clock.t = 50 * 60 * 1000;
    await service.list();

    clock.t = 109 * 60 * 1000; // 109 minutes after the first list, 59 after the second
    assert.deepEqual(await service.setDone(ID1, true), { id: ID1, done: true });
    assert.deepEqual(fetch.calls.map((call) => call.method), ['POST', 'POST', 'PATCH']);
  });

  it('[#10] a list that is served from the 15-second memory is "returned" too: it starts the hour again', async () => {
    const fetch = fakeFetch(queryResponse([notionPage(ID1)]), updateResponse(ID1));
    const clock = { t: 0 };
    const service = makeService(fetch, { clock });
    await service.list(); // t = 0: read from Notion
    clock.t = 14 * 1000;
    await service.list(); // t = 14 s: the same list again, from memory (no new Notion call)
    assert.equal(fetch.calls.length, 1);

    clock.t = 14 * 1000 + HOUR; // an hour after the second return, an hour and 14 seconds after the read
    assert.deepEqual(await service.setDone(ID1, true), { id: ID1, done: true });
    assert.deepEqual(fetch.calls.map((call) => call.method), ['POST', 'PATCH']);
  });

  it('[#10] the list that is read to look for an id counts as "returned" for every row in it', async () => {
    // Opened at t = 0, then used an hour later: the row is checked (the list is read again first and
    // has it), and a minute after that it is set back, when it is no longer in any list.
    const fetch = fakeFetch(
      queryResponse([notionPage(ID1)]), // t = 0: the screen's list
      queryResponse([notionPage(ID1)]), // t = 61 min: read again because the id is too old; the row is there
      updateResponse(ID1), // set to done
      updateResponse(ID1) // set back
    );
    const clock = { t: 0 };
    const service = makeService(fetch, { clock });
    await service.list();

    clock.t = 61 * 60 * 1000;
    await service.setDone(ID1, true);
    clock.t = 62 * 60 * 1000;
    assert.deepEqual(await service.setDone(ID1, false), { id: ID1, done: false });
    assert.deepEqual(fetch.calls.map((call) => call.method), ['POST', 'POST', 'PATCH', 'PATCH']);
  });

  it('[#10] only ids that Notion returned are allowed: another id is still "not found", and a failed write can be tried again', async () => {
    const fetch = fakeFetch(queryResponse([notionPage(ID1)]), failure(500, { code: 'internal_server_error' }), updateResponse(ID1));
    const service = makeService(fetch);
    await service.list();

    assert.equal((await rejection(service.setDone(ID3, true))).kind, 'not_found');
    assert.equal((await rejection(service.setDone(ID1, true))).kind, 'failed');
    assert.deepEqual(await service.setDone(ID1, true), { id: ID1, done: true });
    assert.deepEqual(fetch.calls.map((call) => call.method), ['POST', 'PATCH', 'PATCH']);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('settings (environment variables)', () => {
  it('without the token or without the data source id there is no service (the routes say 503)', () => {
    for (const env of [
      {},
      { NOTION_TOKEN: TOKEN },
      { NOTION_YARUKOTO_DATA_SOURCE_ID: DATA_SOURCE_ID },
      { NOTION_TOKEN: '   ', NOTION_YARUKOTO_DATA_SOURCE_ID: DATA_SOURCE_ID },
      { NOTION_TOKEN: TOKEN, NOTION_YARUKOTO_DATA_SOURCE_ID: '  \t ' },
      { NOTION_TOKEN: '', NOTION_YARUKOTO_DATA_SOURCE_ID: '' },
    ]) {
      assert.equal(notion.createYarukotoFromEnv(env), null, JSON.stringify(env));
    }
  });

  it('surrounding whitespace is ignored in all four settings, and the defaults apply when they are empty', async () => {
    const fetch = fakeFetch(queryResponse([]), queryResponse([]));
    const padded = notion.createYarukotoFromEnv(
      {
        NOTION_TOKEN: `  ${TOKEN}\n`,
        NOTION_YARUKOTO_DATA_SOURCE_ID: ` ${DATA_SOURCE_ID} `,
        NOTION_API_BASE: ' http://127.0.0.1:4321 ',
        NOTION_VERSION: ' 2099-12-31 ',
      },
      { fetch, sleep: noSleep }
    );
    await padded.list();
    assert.equal(fetch.calls[0].url, `http://127.0.0.1:4321/v1/data_sources/${DATA_SOURCE_ID}/query`);
    assert.equal(fetch.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(fetch.calls[0].headers['Notion-Version'], '2099-12-31');

    const defaults = notion.createYarukotoFromEnv(
      { NOTION_TOKEN: TOKEN, NOTION_YARUKOTO_DATA_SOURCE_ID: DATA_SOURCE_ID, NOTION_API_BASE: ' ', NOTION_VERSION: '' },
      { fetch, sleep: noSleep }
    );
    await defaults.list();
    assert.equal(fetch.calls[1].url, `https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`);
    assert.equal(fetch.calls[1].headers['Notion-Version'], '2026-03-11');
  });
});

// ---------------------------------------------------------------------------
// The route handlers
// ---------------------------------------------------------------------------

describe('route handlers', () => {
  it('not configured: both routes answer 503, whatever the request carries', async () => {
    const routes = notion.createRoutes(null);
    const requests = [
      fakeReq(),
      fakeReq({ pageId: ID1, body: { done: true } }),
      fakeReq({ pageId: 'not-an-id', body: { done: 'maybe' } }),
    ];
    for (const req of requests) {
      for (const handler of [routes.list, routes.update]) {
        const res = fakeRes();
        await handler(req, res);
        assert.equal(res.statusCode, 503);
        assert.deepEqual(res.body, { error: 'Notion is not configured' });
      }
    }
  });

  it('GET: 200 with { items } and a no-store header', async () => {
    const fetch = fakeFetch(queryResponse([notionPage(ID1, { title: 'a', business: '株', week: THIS_MONDAY })]));
    const routes = notion.createRoutes(makeService(fetch));
    const res = fakeRes();
    await routes.list(fakeReq(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(Object.keys(res.body), ['items']);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].id, ID1);
    assert.equal(res.body.items[0].category, '株');
  });

  it('PATCH: a page id that is not 32 hex digits (with or without hyphens) is 400, and Notion is not called', async () => {
    const fetch = fakeFetch();
    const routes = notion.createRoutes(makeService(fetch));
    for (const pageId of [
      undefined, '', 'abc', ID1 + '0', ID1.slice(0, -1), 'g'.repeat(32), ' ' + ID1, ID1 + ' ',
      '00000000-0000-4000-8000-00000000000z', '0000000-00000-4000-8000-000000000001',
      '../../v1/users', ID1 + '/../x', '%2e%2e', '000000000000400080000000000000012',
    ]) {
      const res = fakeRes();
      await routes.update(fakeReq({ pageId, body: { done: true } }), res);
      assert.equal(res.statusCode, 400, JSON.stringify(pageId));
      assert.deepEqual(res.body, { error: 'Invalid page id' });
    }
    assert.equal(fetch.calls.length, 0);
  });

  it('PATCH: done that is not true / false (or no body at all) is 400, and Notion is not called', async () => {
    const fetch = fakeFetch();
    const routes = notion.createRoutes(makeService(fetch));
    for (const body of [undefined, null, {}, { done: 'true' }, { done: 1 }, { done: 0 }, { done: null }, { done: [] }, 'done', []]) {
      const res = fakeRes();
      await routes.update(fakeReq({ pageId: ID1, body }), res);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.deepEqual(res.body, { error: 'done must be true or false' });
    }
    assert.equal(fetch.calls.length, 0);
  });

  it('PATCH: 200 with { id, done }; the id is the one Notion uses even if the request wrote it without hyphens', async () => {
    const fetch = fakeFetch(queryResponse([notionPage(ID1)]), updateResponse(ID1));
    const routes = notion.createRoutes(makeService(fetch));
    const res = fakeRes();
    await routes.update(fakeReq({ pageId: ID1.replace(/-/g, ''), body: { done: true } }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { id: ID1, done: true });
  });

  it('Notion fails -> 502 { error: "Notion request failed" }; busy -> 503 { error: "Notion is busy, try again later" }', async () => {
    const logged = [];
    const fetch = fakeFetch(failure(500, { code: 'internal_server_error' }), failure(429, {}, { 'Retry-After': '30' }));
    const routes = notion.createRoutes(makeService(fetch), { log: (...args) => logged.push(args.join(' ')) });

    const failed = fakeRes();
    await routes.list(fakeReq(), failed);
    assert.equal(failed.statusCode, 502);
    assert.deepEqual(failed.body, { error: 'Notion request failed' });

    const busy = fakeRes();
    await routes.list(fakeReq(), busy);
    assert.equal(busy.statusCode, 503);
    assert.deepEqual(busy.body, { error: 'Notion is busy, try again later' });

    assert.equal(logged.length, 2);
    assert.match(logged[0], /HTTP 500 internal_server_error/);
  });

  it('a Notion failure on a PATCH is 502 as well', async () => {
    const fetch = fakeFetch(queryResponse([notionPage(ID1)]), failure(404, { code: 'object_not_found' }));
    const routes = notion.createRoutes(makeService(fetch), { log: () => {} });
    const res = fakeRes();
    await routes.update(fakeReq({ pageId: ID1, body: { done: false } }), res);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.body, { error: 'Notion request failed' });
  });

  it('a bug that is not a NotionError is still a 502 and does not escape', async () => {
    const logged = [];
    const service = { list: async () => { throw new Error('unexpected'); }, setDone: async () => { throw new RangeError('unexpected'); } };
    const routes = notion.createRoutes(service, { log: (...args) => logged.push(args.join(' ')) });

    const res = fakeRes();
    await routes.list(fakeReq(), res);
    assert.equal(res.statusCode, 502);
    const res2 = fakeRes();
    await routes.update(fakeReq({ pageId: ID1, body: { done: true } }), res2);
    assert.equal(res2.statusCode, 502);
    assert.equal(logged.length, 2);
  });
});

// ---------------------------------------------------------------------------
// isValidPageId
// ---------------------------------------------------------------------------

describe('isValidPageId', () => {
  it('accepts 32 hex digits, with the hyphens in their usual places or without any, in either case', () => {
    for (const id of [ID1, ID1.replace(/-/g, ''), ID1.toUpperCase(), 'abcdef0123456789abcdef0123456789', 'ABCDEF01-2345-6789-ABCD-EF0123456789']) {
      assert.equal(notion.isValidPageId(id), true, id);
    }
  });

  it('refuses everything else', () => {
    for (const id of [undefined, null, 5, {}, [], '', 'abc', ID1 + 'a', 'abcdef0123456789abcdef012345678', 'abcdef-0123456789abcdef0123456789', '0000000000004000800000000000000-1']) {
      assert.equal(notion.isValidPageId(id), false, String(id));
    }
  });
});

// ---------------------------------------------------------------------------
// The real server: a visitor who is not logged in
// ---------------------------------------------------------------------------

const SERVER_DIR = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(SERVER_DIR, 'index.js');
const TEMP_PREFIX = 'notion-api-test-';
const running = new Set();

process.on('exit', () => {
  for (const server of running) server.child.kill();
});

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

// Only ever removes a directory this file made itself with mkdtemp in the OS temp dir.
function removeOwnTempDir(dir) {
  const isOwn =
    path.resolve(path.dirname(dir)) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith(TEMP_PREFIX);
  if (!isOwn) return;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Starts index.js as a child process. Settings left out are passed as empty strings on purpose:
 * dotenv never overrides a variable that already exists, so a token in server/.env cannot leak
 * into a test. TASKS_FILE points into the OS temp dir, so server/data/ is never made.
 */
async function startServer({ token = '', dataSourceId = '', apiBase = '' } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const port = await getFreePort();

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // set by the test runner for test files, not meant for the server
  Object.assign(env, {
    PORT: String(port),
    TASKS_FILE: path.join(tmpDir, 'tasks.json'),
    GOOGLE_CLIENT_ID: 'dummy-client-id',
    GOOGLE_CLIENT_SECRET: 'dummy-client-secret',
    CLAUDE_API_TOKEN: '',
    CLAUDE_API_USER_ID: '',
    NOTION_TOKEN: token,
    NOTION_YARUKOTO_DATA_SOURCE_ID: dataSourceId,
    NOTION_API_BASE: apiBase,
    NOTION_VERSION: '',
  });

  const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output += chunk;
    });
  }

  const server = {
    port,
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
      // Generous: several servers (and the other test file's) loading googleapis at once can be slow on a cold disk.
      const timer = setTimeout(() => reject(new Error(`server did not start within 90s. Output:\n${output}`)), 90000);
      child.stdout.on('data', () => {
        if (output.includes('Notion yarukoto:')) {
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

/** A stand-in for Notion on localhost that records every request it gets and answers 500. */
async function startFakeNotion() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

async function call(server, method, route, { headers, body } = {}) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(15000) };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
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

describe('GET /api/yarukoto and PATCH /api/yarukoto/:pageId in the real server', () => {
  let fakeNotion;
  let configured;
  let unconfigured;

  before(async () => {
    fakeNotion = await startFakeNotion();
    [configured, unconfigured] = await Promise.all([
      startServer({ token: TOKEN, dataSourceId: DATA_SOURCE_ID, apiBase: fakeNotion.base }),
      startServer(),
    ]);
  });
  after(async () => {
    await Promise.all([configured, unconfigured].filter(Boolean).map((server) => server.stop()));
    if (fakeNotion) await fakeNotion.stop();
  });

  it('settings in place: GET without a login is 401 as JSON (not the SPA page), and Notion is not called', async () => {
    const res = await call(configured, 'GET', '/api/yarukoto');
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'Authentication required' });
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(fakeNotion.requests.length, 0);
  });

  it('settings in place: PATCH without a login is 401, whatever the id and the body are, and Notion is not called', async () => {
    const requests = [
      [ID1, { done: true }],
      [ID1, { done: false }],
      [ID1, undefined],
      ['not-an-id', { done: 'maybe' }],
    ];
    for (const [id, body] of requests) {
      const res = await call(configured, 'PATCH', `/api/yarukoto/${id}`, { body });
      assert.equal(res.status, 401, `${id} ${JSON.stringify(body)}`);
      assert.deepEqual(res.json, { error: 'Authentication required' });
    }
    assert.equal(fakeNotion.requests.length, 0);
  });

  it('no settings: a visitor who is not logged in still gets 401 (the login check comes before the 503)', async () => {
    const get = await call(unconfigured, 'GET', '/api/yarukoto');
    assert.equal(get.status, 401);
    assert.deepEqual(get.json, { error: 'Authentication required' });

    const patch = await call(unconfigured, 'PATCH', `/api/yarukoto/${ID1}`, { body: { done: true } });
    assert.equal(patch.status, 401);
  });

  it('the startup output says whether Notion is on, and never prints the token', async () => {
    assert.match(configured.output(), /Notion yarukoto: enabled/);
    assert.match(unconfigured.output(), /Notion yarukoto: disabled/);
    assert.ok(!configured.output().includes(TOKEN), 'the token must not be printed');
    assert.ok(!unconfigured.output().includes(TOKEN));
  });
});
