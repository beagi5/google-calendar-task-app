'use strict';

/*
 * Tests for server/calendar-done.js (the "[完了] " title and the Graphite color of a done event).
 * Run with: cd server && npm test   (node --test; no network)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { completionPatch, DONE_COLOR_ID, COLOR_BEFORE_DONE_KEY } = require('../calendar-done');

const kept = (value) => ({ private: { [COLOR_BEFORE_DONE_KEY]: value } });

describe('completionPatch: marking done', () => {
  it('adds the prefix, turns the event Graphite and keeps the color it had', () => {
    assert.deepEqual(completionPatch({ summary: 'MTG_YCDC', colorId: '11' }, true), {
      summary: '[完了] MTG_YCDC',
      colorId: DONE_COLOR_ID,
      extendedProperties: kept('11'),
    });
  });

  it("keeps '' for an event on the calendar's default color", () => {
    assert.deepEqual(completionPatch({ summary: 'シフト：入り' }, true), {
      summary: '[完了] シフト：入り',
      colorId: '8',
      extendedProperties: kept(''),
    });
  });

  it('does not add the prefix twice', () => {
    assert.equal(completionPatch({ summary: '[完了] 病院', colorId: '4' }, true).summary, '[完了] 病院');
  });

  it('marking an already Graphite event done again does not overwrite the kept color', () => {
    const patch = completionPatch({ summary: '[完了] 病院', colorId: '8', extendedProperties: kept('4') }, true);
    assert.deepEqual(patch, { summary: '[完了] 病院' });
  });

  it('copes with an event without a title', () => {
    assert.equal(completionPatch({ colorId: '2' }, true).summary, '[完了] ');
    assert.equal(completionPatch(undefined, true).summary, '[完了] ');
  });
});

describe('completionPatch: taking done off', () => {
  it('removes the prefix, puts the kept color back and clears the kept value', () => {
    assert.deepEqual(completionPatch({ summary: '[完了] MTG_YCDC', colorId: '8', extendedProperties: kept('11') }, false), {
      summary: 'MTG_YCDC',
      colorId: '11',
      extendedProperties: kept(null),
    });
  });

  it("goes back to the calendar's default color when the kept color is ''", () => {
    const patch = completionPatch({ summary: '[完了] シフト：入り', colorId: '8', extendedProperties: kept('') }, false);
    assert.equal(patch.colorId, null);
    assert.deepEqual(patch.extendedProperties, kept(null));
  });

  it("goes back to the calendar's default color when no color was kept (made done by hand)", () => {
    assert.deepEqual(completionPatch({ summary: '[完了] 入り', colorId: '8' }, false), {
      summary: '入り',
      colorId: null,
    });
  });

  it('leaves a color that was changed by hand after the event was made done', () => {
    assert.deepEqual(completionPatch({ summary: '[完了] 病院', colorId: '5', extendedProperties: kept('4') }, false), {
      summary: '病院',
      extendedProperties: kept(null),
    });
  });

  it('keeps other private properties out of the patch', () => {
    const ev = { summary: '[完了] x', colorId: '8', extendedProperties: { private: { other: 'a', [COLOR_BEFORE_DONE_KEY]: '3' } } };
    assert.deepEqual(completionPatch(ev, false).extendedProperties, kept(null));
  });

  it('only touches the title of an event that was never done', () => {
    assert.deepEqual(completionPatch({ summary: '日勤', colorId: '9' }, false), { summary: '日勤' });
  });
});
