'use strict';

/*
 * What "done" looks like on a Google Calendar event, and the patch that turns it on or off.
 *
 * - A done event's title starts with "[完了] " and its color is Graphite (colorId 8). Graphite is
 *   kept for "done" only (the owner's choice, 2026-10-23), so a done event can be told apart at a
 *   glance in Google Calendar itself, not only in this app.
 * - The color the event had before is kept on the event, in extendedProperties.private
 *   (key colorBeforeDone, '' for the calendar's default color), so that taking "done" off puts the
 *   color back. With no kept color (an event made done by hand or by another tool), taking "done"
 *   off falls back to the calendar's default color.
 * - completionPatch() is pure: it takes the event as Calendar returns it and gives back the body
 *   for events.patch. Nothing here talks to Google, so calendar-done.test.js needs no network.
 */

const COMPLETED_PREFIX = '[完了] ';
const DONE_COLOR_ID = '8';
const COLOR_BEFORE_DONE_KEY = 'colorBeforeDone';

function completionPatch(event, completed) {
  let summary = (event && event.summary) || '';
  if (completed && !summary.startsWith(COMPLETED_PREFIX)) summary = COMPLETED_PREFIX + summary;
  if (!completed && summary.startsWith(COMPLETED_PREFIX)) summary = summary.slice(COMPLETED_PREFIX.length);

  const patch = { summary };
  const colorId = (event && event.colorId) || '';
  const kept = event && event.extendedProperties && event.extendedProperties.private
    ? event.extendedProperties.private[COLOR_BEFORE_DONE_KEY]
    : undefined;

  if (completed) {
    // Already Graphite: keep whatever "before" color is there (marking done twice must not lose it).
    if (colorId !== DONE_COLOR_ID) {
      patch.colorId = DONE_COLOR_ID;
      patch.extendedProperties = { private: { [COLOR_BEFORE_DONE_KEY]: colorId } };
    }
  } else {
    // Only undo our own color: a done event that was recolored by hand keeps the new color.
    if (colorId === DONE_COLOR_ID) patch.colorId = kept ? kept : null; // null = the calendar's default
    if (kept !== undefined) patch.extendedProperties = { private: { [COLOR_BEFORE_DONE_KEY]: null } };
  }
  return patch;
}

module.exports = {
  COMPLETED_PREFIX,
  DONE_COLOR_ID,
  COLOR_BEFORE_DONE_KEY,
  completionPatch,
};
