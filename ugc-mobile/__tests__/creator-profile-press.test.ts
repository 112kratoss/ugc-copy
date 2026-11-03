import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { transformSync } from '@babel/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CREATOR_PROFILE_PRESS_DELAY_MS,
  creatorProfilePress,
  setCreatorProfilePreparer,
  type CreatorProfilePress,
} from '../lib/creator-profile-opening';

const mobileRoot = path.resolve(__dirname, '..');
const requireFromMobile = createRequire(path.join(mobileRoot, 'package.json'));

type PressabilityConfig = {
  delayPressIn?: number | null;
  onPressIn?: () => void;
  onPress?: () => void;
};
type ResponderHandlers = {
  onStartShouldSetResponder: () => boolean;
  onResponderGrant: (event: unknown) => void;
  onResponderMove: (event: unknown) => void;
  onResponderRelease: (event: unknown) => void;
  onResponderTerminate: (event: unknown) => void;
};
type PressabilityClass = new (config: PressabilityConfig) => { getEventHandlers: () => ResponderHandlers; reset: () => void };

/**
 * React Native's Pressability, the file that ships, read with the Hermes
 * parser as React Native's own Babel preset reads it, its Flow stripped, over
 * stand-ins for the native modules it reaches. It is what decides when a
 * Pressable calls `onPressIn`: a double of `react-native` hands a test the
 * handlers a component passed, and cannot say whether a touch that a scroll
 * view takes away ever pressed in.
 */
function loadPressability(): PressabilityClass {
  const filename = requireFromMobile.resolve('react-native/Libraries/Pressability/Pressability.js');
  const { code } = transformSync(readFileSync(filename, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename,
    plugins: [
      requireFromMobile.resolve('babel-plugin-syntax-hermes-parser'),
      requireFromMobile.resolve('@babel/plugin-transform-flow-strip-types'),
      requireFromMobile.resolve('@babel/plugin-transform-modules-commonjs'),
    ],
  })!;
  const standIns: Record<string, unknown> = {
    '../../src/private/featureflags/ReactNativeFeatureFlags': { shouldPressibilityUseW3CPointerEventsForHover: () => false },
    '../Components/Sound/SoundManager': { __esModule: true, default: { playTouchSound: () => undefined } },
    '../ReactNative/UIManager': { __esModule: true, default: { measure: () => undefined } },
    '../StyleSheet/Rect': {
      normalizeRect: (rect: unknown) => (typeof rect === 'number' ? { top: rect, left: rect, bottom: rect, right: rect } : rect),
    },
    '../Utilities/Platform': { __esModule: true, default: { OS: 'ios' } },
    './HoverState': { isHoverEnabled: () => false },
    './PressabilityPerformanceEventEmitter.js': { __esModule: true, default: { emitEvent: () => undefined } },
    invariant: requireFromMobile('invariant'),
  };
  const loaded = { exports: {} as { default?: PressabilityClass } };
  const load = (specifier: string) => {
    if (!(specifier in standIns)) throw new Error(`Pressability asked for ${specifier}, which this test has no stand-in for.`);
    return standIns[specifier];
  };
  new Function('require', 'module', 'exports', code!)(load, loaded, loaded.exports);
  if (!loaded.exports.default) throw new Error('Pressability.js no longer exports its class as the default.');
  return loaded.exports.default;
}

const Pressability = loadPressability();

/** The handle as it sits on screen, 200 by 40, measured where Pressability asks. */
const handleView = {
  measure: (callback: (...frame: number[]) => void) => callback(0, 0, 200, 40, 0, 0),
};

function touch(at: { x: number; y: number }, lifted = false) {
  const finger = { identifier: 0, pageX: at.x, pageY: at.y, locationX: at.x, locationY: at.y, timestamp: Date.now() };
  return {
    persist: () => undefined,
    currentTarget: handleView,
    nativeEvent: { ...finger, touches: lifted ? [] : [finger], changedTouches: [finger] },
  };
}

/**
 * A creator's handle, given the props `creatorProfilePress` hands it, as
 * Pressable hands them to Pressability (`delayPressIn: unstable_pressDelay`).
 */
function handle(press: Partial<CreatorProfilePress>) {
  const handlers = new Pressability({
    delayPressIn: press.unstable_pressDelay,
    onPressIn: press.onPressIn,
    onPress: press.onPress,
  }).getEventHandlers();
  const at = { x: 20, y: 20 };
  return {
    fingerDown: () => {
      handlers.onStartShouldSetResponder();
      handlers.onResponderGrant(touch(at));
    },
    fingerMoves: (to: { x: number; y: number }) => handlers.onResponderMove(touch(to)),
    fingerUp: (to = at) => handlers.onResponderRelease(touch(to, true)),
    /** A scroll view or a pager takes the touch, as it does once the finger travels. */
    touchTakenAway: () => handlers.onResponderTerminate(touch(at, true)),
  };
}

const log: string[] = [];
let removePreparer: () => void = () => undefined;

beforeEach(() => {
  vi.useFakeTimers();
  removePreparer = setCreatorProfilePreparer((username) => log.push(`read ${username}`));
});

afterEach(() => {
  removePreparer();
  log.length = 0;
  vi.useRealTimers();
});

const lunaPress = () => creatorProfilePress('luna', () => log.push('open'));

// Review of #679: with the read at press-in and no wait, a feed scroll that
// began on a byline, or a reel swipe that began on the creator row, read that
// creator's page.
describe("a touch on a creator's handle, through React Native's Pressability", () => {
  it('reads nothing when its list or pager takes the touch before the finger has rested', () => {
    const row = handle(lunaPress());

    row.fingerDown();
    vi.advanceTimersByTime(40);
    row.touchTakenAway();
    vi.advanceTimersByTime(1000);

    expect(log).toEqual([]);
  });

  it('reads nothing when the finger slides off the handle before then', () => {
    const row = handle(lunaPress());

    row.fingerDown();
    vi.advanceTimersByTime(30);
    row.fingerMoves({ x: 20, y: 300 });
    vi.advanceTimersByTime(1000);
    row.fingerUp({ x: 20, y: 300 });

    expect(log).toEqual([]);
  });

  it('reads the page once the finger has rested, and opens nothing when a scroll takes the touch after that', () => {
    const row = handle(lunaPress());

    row.fingerDown();
    vi.advanceTimersByTime(CREATOR_PROFILE_PRESS_DELAY_MS - 1);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(['read luna']);
    row.touchTakenAway();

    expect(log).toEqual(['read luna']);
  });

  it('reads the page as a quick tap lets go, just before it opens the page', () => {
    const row = handle(lunaPress());

    row.fingerDown();
    vi.advanceTimersByTime(50);
    row.fingerUp();

    expect(log).toEqual(['read luna', 'open']);
  });

  it('reads once for a press held past the wait, and opens as it lets go', () => {
    const row = handle(lunaPress());

    row.fingerDown();
    vi.advanceTimersByTime(400);
    expect(log).toEqual(['read luna']);
    row.fingerUp();

    expect(log).toEqual(['read luna', 'open']);
  });

  it('reads nothing for a creator with no handle to open', () => {
    const row = handle(creatorProfilePress(null, () => log.push('open')));

    row.fingerDown();
    vi.advanceTimersByTime(50);
    row.fingerUp();

    expect(log).toEqual(['open']);
  });

  // The same touch on a handle wired as the openers were before: the read at
  // press-in, no wait. It shows the case above can tell the two apart.
  it('without the wait, has read the page by the time its list takes the touch', () => {
    const { onPressIn, onPress } = lunaPress();
    const row = handle({ onPressIn, onPress });

    row.fingerDown();
    row.touchTakenAway();

    expect(log).toEqual(['read luna']);
  });

  it('is the wait Pressable hands Pressability as its press-in delay', () => {
    const pressable = readFileSync(requireFromMobile.resolve('react-native/Libraries/Components/Pressable/Pressable.js'), 'utf8');
    expect(pressable).toMatch(/delayPressIn: unstable_pressDelay,/);
    expect(lunaPress()).toMatchObject({ unstable_pressDelay: CREATOR_PROFILE_PRESS_DELAY_MS });
  });
});
