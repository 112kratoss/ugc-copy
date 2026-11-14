import { describe, expect, it, vi } from 'vitest';

import {
  SEARCH_ENTRANCE,
  SEARCH_ENTRANCE_AT_REST,
  searchEntranceStart,
  searchFieldRestingFrame,
  usableSearchEntranceOrigin,
} from '../lib/search-entrance';
import { createSearchScreenOpener, SEARCH_SCREEN_ORIGIN_TTL_MS } from '../lib/search-screen-route';

// Search opens out of the control that was pressed, as iOS's Search grows out
// of the home screen's Search button (owner, 2026-11-14; lib/search-entrance.ts).
const window = { width: 402, height: 874 };
// The field as the header lays it out on a 402-point iPhone under a 62-point inset.
const field = searchFieldRestingFrame({ windowWidth: 402, topInset: 62, topGap: 8, screenPadding: 16, leadingWidth: 44, gap: 10, height: 50 });
const icon = { iconSize: 22, iconInset: 16 };

describe('search entrance geometry', () => {
  it('places the field after the back button, across to the screen margin', () => {
    expect(field).toEqual({ x: 70, y: 70, width: 316, height: 50 });
  });

  it('starts the capsule on a round button and the magnifier at its middle', () => {
    const start = searchEntranceStart({ x: 270, y: 72, width: 48, height: 48, kind: 'button' }, field, icon);
    // Insets from the field's frame to the button's.
    expect(start).toMatchObject({ left: 200, top: 2, right: 68, bottom: 0, textShown: false });
    // From the button's middle (294, 96) to the magnifier's place (97, 95).
    expect(start.iconX).toBe(197);
    expect(start.iconY).toBe(1);
  });

  it('starts on a bar drawn as the field is with its text on show, the magnifier where the bar draws it', () => {
    const start = searchEntranceStart({ x: 16, y: 130, width: 370, height: 46, kind: 'field' }, field, icon);
    expect(start).toMatchObject({ left: -54, top: 60, right: 0, bottom: -56, textShown: true });
    expect(start.iconX).toBe(-54);
    expect(start.iconY).toBe(58);
  });

  it('rests where it is with nothing to grow out of', () => {
    expect(searchEntranceStart(null, field, icon)).toBe(SEARCH_ENTRANCE_AT_REST);
  });

  it('grows out of a control only when it was measured on screen at a usable size', () => {
    const button = { x: 270, y: 72, width: 48, height: 48, kind: 'button' as const };
    expect(usableSearchEntranceOrigin(button, window)).toBe(button);
    expect(usableSearchEntranceOrigin(null, window)).toBeNull();
    expect(usableSearchEntranceOrigin({ ...button, width: 0 }, window)).toBeNull();
    expect(usableSearchEntranceOrigin({ ...button, x: Number.NaN }, window)).toBeNull();
    expect(usableSearchEntranceOrigin({ ...button, x: -60 }, window)).toBeNull();
    expect(usableSearchEntranceOrigin({ ...button, y: 900 }, window)).toBeNull();
    // Partly on screen is enough: the capsule starts where it was.
    expect(usableSearchEntranceOrigin({ ...button, y: -20 }, window)).not.toBeNull();
  });

  it('takes taps only once the field has nearly arrived, and pops only once it is back in its control', () => {
    expect(SEARCH_ENTRANCE.touchesAfterMs).toBeGreaterThanOrEqual(250);
    // The focus (the keyboard's setup holds the UI thread) waits until the growth has ended,
    // a frame or more, so no frame of it is drawn while the thread is held.
    expect(SEARCH_ENTRANCE.touchesAfterMs).toBeGreaterThanOrEqual(SEARCH_ENTRANCE.growMs + 16);
    // The navigator draws a leaving screen as a still picture: a pop before the
    // shrink lands would freeze the field part-way. On the exit's ease-out
    // cubic it is at least 97% of the way home when the pop is asked for.
    const travelled = 1 - (1 - SEARCH_ENTRANCE.popAfterMs / SEARCH_ENTRANCE.exitMs) ** 3;
    expect(travelled).toBeGreaterThanOrEqual(0.97);
    expect(SEARCH_ENTRANCE.popAfterMs).toBeLessThan(SEARCH_ENTRANCE.exitMs);
  });
});

describe('the shared opener', () => {
  it('hands the screen the control it was opened from, for as long as that screen is up', () => {
    const push = vi.fn();
    const opener = createSearchScreenOpener({ push, now: () => 0 });
    const from = { x: 270, y: 72, width: 48, height: 48, kind: 'button' as const };
    expect(opener.open(from)).toBe(true);
    opener.screenMounted();
    // Read again by a render React repeats: the same control.
    expect(opener.takeOrigin()).toBe(from);
    expect(opener.takeOrigin()).toBe(from);
    opener.screenUnmounted();
    // Nothing left for a screen a link opens next.
    expect(opener.takeOrigin()).toBeNull();
  });

  it('gives a screen mounting long after the push no control: it grows out of nothing (review of #812, 3)', () => {
    let clock = 0;
    const opener = createSearchScreenOpener({ push: vi.fn(), now: () => clock });
    const from = { x: 270, y: 72, width: 48, height: 48, kind: 'button' as const };
    opener.open(from);
    clock = SEARCH_SCREEN_ORIGIN_TTL_MS;
    expect(opener.takeOrigin()).toBe(from);
    clock = SEARCH_SCREEN_ORIGIN_TTL_MS + 1;
    expect(opener.takeOrigin()).toBeNull();
  });

  it('opens with no control from an entry that gives none', () => {
    const opener = createSearchScreenOpener({ push: vi.fn(), now: () => 0 });
    opener.open();
    expect(opener.takeOrigin()).toBeNull();
  });
});
