import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A still picture's own flight home when the reel's Back is pressed
 * (lib/reel-close-flight.ts): the picture leaves the page in the frame the
 * finger lifts, travels to its tile on one curve and lands on it. How it looks
 * is filmed, not tested; this is its curves, where it starts and ends, the
 * frames it is stepped by, and what happens to the tile and the page around it.
 */

import {
  holdAppleZoomReturnPicture,
  isAppleZoomReturnPictureHeld,
  resetAppleZoomReturnPictures,
} from '../lib/apple-zoom-surface';
import { registerZoomSource, resetMediaZoomTransitions } from '../lib/media-zoom-transition';
import {
  armReelCloseFlight,
  confirmReelCloseFlight,
  disarmReelCloseFlight,
  forgetReelCloseFlight,
  getReelCloseFlightPicture,
  isInReelBackRegion,
  isReelCloseFlightArmed,
  isReelCloseFlightPictureDisplayed,
  nextReelCloseFlightId,
  noteReelCloseFlightPictureDisplayed,
  offerReelCloseFlightPicture,
  REEL_CLOSE_FLIGHT_GROUND_GONE_AT,
  REEL_CLOSE_FLIGHT_LANDING_FADE_MS,
  REEL_CLOSE_FLIGHT_LANDS_AT,
  REEL_CLOSE_FLIGHT_MAX_STEP_MS,
  REEL_CLOSE_FLIGHT_MS,
  REEL_CLOSE_FLIGHT_UNCONFIRMED_MS,
  reelBackButtonRegion,
  reelCloseFlightCoversTile,
  reelCloseFlightFloor,
  reelCloseFlightFloorAt,
  reelCloseFlightFlying,
  reelCloseFlightFrame,
  reelCloseFlightGround,
  reelCloseFlightHides,
  reelCloseFlightPicture,
  reelCloseFlightSource,
  reelCloseFlightTime,
  reelCloseFlightTravel,
  resetReelCloseFlight,
  subscribeToReelCloseFlight,
  takeOffReelCloseFlight,
  withdrawReelCloseFlightPicture,
  type ReelCloseFlightPlan,
} from '../lib/reel-close-flight';

/** A square picture on an iPhone 17 Pro's page, and an Explore tile for it. */
const FROM = { x: 0, y: 236, width: 402, height: 402 };
const TILE = { x: 205, y: 196, width: 185, height: 185 };
const REEL = 3;
const PLAN: ReelCloseFlightPlan = {
  reelId: REEL,
  from: FROM,
  to: TILE,
  radius: 16,
  sourceId: 'zoom|explore|post-1',
  floorFrom: 0,
  floorTo: 0,
  capLeft: 0,
  capWidth: 0,
  capHeight: 0,
  back: reelBackButtonRegion(62),
};

/** The frames the UI thread would deliver, run by hand. */
let frames: ((now: number) => void)[] = [];
let clock = 0;
function runFrame(after: number) {
  clock += after;
  const due = frames;
  frames = [];
  due.forEach((frame) => frame(clock));
}
/** Runs frames `step` ms apart until the picture counts as landed, and says how many ran. */
function runToLanding(step = 8) {
  let ran = 0;
  while (frames.length > 0 && ran < 1000 && reelCloseFlightTravel(reelCloseFlightTime.value) < REEL_CLOSE_FLIGHT_LANDS_AT) {
    runFrame(step);
    ran += 1;
  }
  return ran;
}

let tileHidden = false;
let unregisterTile: () => void = () => {};

function arm(plan: ReelCloseFlightPlan = PLAN, hidden = true) {
  armReelCloseFlight(plan, { surfaceId: 'explore', itemId: 'post-1', hidden });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('requestAnimationFrame', (frame: (now: number) => void) => {
    frames.push(frame);
    return frames.length;
  });
  frames = [];
  clock = 1000;
  tileHidden = false;
  unregisterTile = registerZoomSource('explore', 'post-1', {
    radius: 16,
    aspectRatio: 1,
    preview: null,
    measure: (report) => report(TILE),
    setHidden: (hidden) => {
      tileHidden = hidden;
    },
  });
  holdAppleZoomReturnPicture('explore', 'post-1');
});

afterEach(() => {
  unregisterTile();
  resetReelCloseFlight();
  resetMediaZoomTransitions();
  resetAppleZoomReturnPictures();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('how far the picture has gone', () => {
  it('starts at rest and ends on the tile', () => {
    expect(reelCloseFlightTravel(0)).toBe(0);
    expect(reelCloseFlightTravel(-1)).toBe(0);
    expect(reelCloseFlightTravel(1)).toBe(1);
    expect(reelCloseFlightTravel(2)).toBe(1);
  });

  it('only ever goes forward', () => {
    let last = 0;
    for (let time = 0.01; time <= 1; time += 0.01) {
      const travelled = reelCloseFlightTravel(time);
      expect(travelled).toBeGreaterThanOrEqual(last);
      last = travelled;
    }
  });

  // One frame of a 120 Hz screen: a start from rest, not a tenth of the way.
  it('moves a point or two in its first frame', () => {
    expect(reelCloseFlightTravel(8 / REEL_CLOSE_FLIGHT_MS)).toBeLessThan(0.03);
  });

  it('is most of the way home by half time, and settles after', () => {
    expect(reelCloseFlightTravel(0.5)).toBeGreaterThan(0.85);
    expect(reelCloseFlightTravel(0.5)).toBeLessThan(1);
  });
});

describe('the black under the picture', () => {
  it('is whole as the picture leaves and gone part of the way there', () => {
    expect(reelCloseFlightGround(0)).toBe(1);
    expect(reelCloseFlightGround(REEL_CLOSE_FLIGHT_GROUND_GONE_AT)).toBe(0);
    expect(reelCloseFlightGround(1)).toBe(0);
  });

  it('only ever thins', () => {
    let last = 1;
    for (let time = 0; time <= 1; time += 0.02) {
      const left = reelCloseFlightGround(time);
      expect(left).toBeLessThanOrEqual(last);
      last = left;
    }
  });
});

describe('where the picture is', () => {
  it('leaves from exactly where the page draws it', () => {
    expect(reelCloseFlightFrame(PLAN, 0)).toEqual({
      x: FROM.x, y: FROM.y, width: FROM.width, height: FROM.height, radius: 0, scale: 1, imageX: 0, imageY: 0,
    });
  });

  it('lands on the tile, in the tile\'s corners', () => {
    const landed = reelCloseFlightFrame(PLAN, 1);
    expect(landed.x).toBeCloseTo(TILE.x);
    expect(landed.y).toBeCloseTo(TILE.y);
    expect(landed.width).toBeCloseTo(TILE.width);
    expect(landed.height).toBeCloseTo(TILE.height);
    expect(landed.radius).toBe(16);
  });

  // A tile crops its picture to its own shape about the centre: so does this.
  it.each([
    ['a tall picture into a square tile', { x: 40, y: 0, width: 322, height: 874 }, { x: 16, y: 300, width: 180, height: 180 }],
    ['a wide picture into a tall tile', { x: 0, y: 324, width: 402, height: 226 }, { x: 200, y: 500, width: 185, height: 230 }],
    ['a picture into a tile of its own shape', FROM, TILE],
  ])('covers its window all the way, centred: %s', (_name, from, to) => {
    for (let time = 0; time <= 1.0001; time += 0.05) {
      const frame = reelCloseFlightFrame({ from, to, radius: 12 }, Math.min(1, time));
      const drawnWidth = from.width * frame.scale;
      const drawnHeight = from.height * frame.scale;
      expect(drawnWidth).toBeGreaterThanOrEqual(frame.width - 0.001);
      expect(drawnHeight).toBeGreaterThanOrEqual(frame.height - 0.001);
      // Scaled about its own centre and moved: its centre is the window's.
      expect(from.width / 2 + frame.imageX).toBeCloseTo(frame.width / 2);
      expect(from.height / 2 + frame.imageY).toBeCloseTo(frame.height / 2);
    }
    const landed = reelCloseFlightFrame({ from, to, radius: 12 }, 1);
    // And on the tile it is the tile's own crop: it fits one way exactly.
    const fitsWidth = Math.abs(from.width * landed.scale - to.width) < 0.001;
    const fitsHeight = Math.abs(from.height * landed.scale - to.height) < 0.001;
    expect(fitsWidth || fitsHeight).toBe(true);
  });
});

// The flight is drawn above the navigator, tab bar and all, and a tile can sit
// partly under that bar: landed on top of it, the picture covered the bar's
// buttons and they came back through it as it faded (owner's recording,
// 2026-11-10).
describe('a tile under its screen\'s bar', () => {
  const SCREEN = { width: 402, height: 874 };
  // The tab bar on an iPhone 17 Pro: its capsule, and the Create button standing up out of it.
  const BAR = { height: 100, capWidth: 64, capHeight: 22 };
  const UNDER = { x: 12, y: 567, width: 183, height: 256 };
  const NOTHING = { floorFrom: 0, floorTo: 0, capLeft: 0, capWidth: 0, capHeight: 0 };

  it('holds nothing back for a tile that ends above the bar, or a screen with no bar', () => {
    expect(reelCloseFlightFloor(FROM, TILE, SCREEN, BAR)).toEqual(NOTHING);
    expect(reelCloseFlightFloor(FROM, UNDER, SCREEN, { height: 0, capWidth: 0, capHeight: 0 })).toEqual(NOTHING);
    // Ending exactly where the bar begins is above it.
    expect(reelCloseFlightFloor(FROM, { ...UNDER, y: 518 }, SCREEN, BAR)).toEqual(NOTHING);
  });

  it('stops the picture where the bar begins, all the way, when it starts above the bar', () => {
    // A square picture in the middle of the page ends 236 pt above the foot.
    expect(reelCloseFlightFloor(FROM, UNDER, SCREEN, BAR)).toEqual({ floorFrom: 100, floorTo: 100, capLeft: 169, capWidth: 64, capHeight: 22 });
  });

  it('lets a picture that reaches the foot of the page start whole', () => {
    const tall = { x: 0, y: 0, width: 402, height: 874 };
    expect(reelCloseFlightFloor(tall, UNDER, SCREEN, BAR)).toMatchObject({ floorFrom: 0, floorTo: 100 });
    const nearly = { x: 0, y: 80, width: 402, height: 754 };
    expect(reelCloseFlightFloor(nearly, UNDER, SCREEN, BAR)).toMatchObject({ floorFrom: 40, floorTo: 100 });
  });

  it('gives that strip up as the black over the feed goes, and no later, the bar\'s button with it', () => {
    const plan = { floorFrom: 0, floorTo: 100, capHeight: 22 };
    expect(reelCloseFlightFloorAt(plan, 0)).toEqual({ floor: 0, cap: 0 });
    const half = reelCloseFlightFloorAt(plan, REEL_CLOSE_FLIGHT_GROUND_GONE_AT / 2);
    expect(half.floor).toBeCloseTo(50);
    expect(half.cap).toBeCloseTo(11);
    expect(reelCloseFlightFloorAt(plan, REEL_CLOSE_FLIGHT_GROUND_GONE_AT)).toEqual({ floor: 100, cap: 22 });
    expect(reelCloseFlightFloorAt(plan, 1)).toEqual({ floor: 100, cap: 22 });
    // Clear of the bar from the start: clear of its button from the start.
    expect(reelCloseFlightFloorAt({ floorFrom: 100, floorTo: 100, capHeight: 22 }, 0)).toEqual({ floor: 100, cap: 22 });
    expect(reelCloseFlightFloorAt({ floorFrom: 0, floorTo: 0, capHeight: 0 }, 0.7)).toEqual({ floor: 0, cap: 0 });
  });

  // Hidden for the flight, a tile under the bar left the bar's glass dark
  // until the picture landed, when its colours came back into it at once.
  it('need not be hidden when the picture covers what can be seen of it all the way', () => {
    // A tall picture, the width of the screen, down to the bar: the tile is under it throughout.
    const tall = { x: 0, y: 78, width: 402, height: 717 };
    expect(reelCloseFlightCoversTile(tall, UNDER, 874, 100)).toBe(true);
    // It stops short of where the tile can be seen to end.
    expect(reelCloseFlightCoversTile({ ...tall, height: 600 }, UNDER, 874, 100)).toBe(false);
    // With no bar the tile is seen to its foot, which that picture does not reach.
    expect(reelCloseFlightCoversTile(tall, UNDER, 874, 0)).toBe(false);
    // The tile starts above the picture, or is wider than it on a side.
    expect(reelCloseFlightCoversTile(FROM, TILE, 874, 0)).toBe(false);
    expect(reelCloseFlightCoversTile({ x: 40, y: 0, width: 322, height: 874 }, UNDER, 874, 100)).toBe(false);
  });
});

describe('the bar\'s Back', () => {
  it('is where the button is drawn, and nowhere else', () => {
    const region = reelBackButtonRegion(62);
    // The button's centre on an iPhone 17 Pro, and its edges.
    expect(isInReelBackRegion(region, 37, 84)).toBe(true);
    expect(isInReelBackRegion(region, 17, 63)).toBe(true);
    expect(isInReelBackRegion(region, 59, 105)).toBe(true);
    // The picture under it, the status bar above it, the middle of the bar.
    expect(isInReelBackRegion(region, 37, 140)).toBe(false);
    expect(isInReelBackRegion(region, 37, 30)).toBe(false);
    expect(isInReelBackRegion(region, 200, 84)).toBe(false);
  });

  it('gives each reel a number of its own, never 0', () => {
    const first = nextReelCloseFlightId();
    const second = nextReelCloseFlightId();
    expect(first).not.toBe(0);
    expect(second).not.toBe(first);
  });
});

describe('the picture the layer draws ahead of a press', () => {
  const SPEC = { key: 'k1', url: 'https://example.test/p.webp', cacheKey: 'p', from: FROM };

  it('is the one the resting reel offers, drawn or not, until it is withdrawn', () => {
    const heard = vi.fn();
    subscribeToReelCloseFlight(heard);
    offerReelCloseFlightPicture(SPEC);
    expect(getReelCloseFlightPicture()).toEqual(SPEC);
    expect(isReelCloseFlightPictureDisplayed('k1')).toBe(false);
    noteReelCloseFlightPictureDisplayed('k1');
    expect(isReelCloseFlightPictureDisplayed('k1')).toBe(true);
    withdrawReelCloseFlightPicture('k1');
    expect(getReelCloseFlightPicture()).toBeNull();
    expect(isReelCloseFlightPictureDisplayed('k1')).toBe(false);
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it('is not drawn again for the same picture in the same place', () => {
    const heard = vi.fn();
    offerReelCloseFlightPicture(SPEC);
    noteReelCloseFlightPictureDisplayed('k1');
    subscribeToReelCloseFlight(heard);
    offerReelCloseFlightPicture({ ...SPEC, from: { ...FROM } });
    expect(heard).not.toHaveBeenCalled();
    expect(isReelCloseFlightPictureDisplayed('k1')).toBe(true);
  });

  it('has to be drawn again when the picture changes', () => {
    offerReelCloseFlightPicture(SPEC);
    noteReelCloseFlightPictureDisplayed('k1');
    offerReelCloseFlightPicture({ ...SPEC, key: 'k2' });
    expect(isReelCloseFlightPictureDisplayed('k2')).toBe(false);
    // A late report for the picture before says nothing of this one.
    noteReelCloseFlightPictureDisplayed('k1');
    expect(isReelCloseFlightPictureDisplayed('k2')).toBe(false);
  });

  it('is left alone by a reel that never offered it', () => {
    offerReelCloseFlightPicture(SPEC);
    withdrawReelCloseFlightPicture('other');
    expect(getReelCloseFlightPicture()).toEqual(SPEC);
  });
});

describe('a press of the bar\'s Back', () => {
  it('flies nothing while no picture is armed', () => {
    expect(isReelCloseFlightArmed()).toBe(false);
    expect(takeOffReelCloseFlight()).toBe(false);
    expect(reelCloseFlightFlying.value).toBeNull();
    arm();
    disarmReelCloseFlight(REEL);
    expect(takeOffReelCloseFlight()).toBe(false);
  });

  it('is disarmed only by the reel that armed it', () => {
    arm();
    disarmReelCloseFlight(REEL + 1);
    expect(isReelCloseFlightArmed()).toBe(true);
  });

  it('takes the picture off in that frame: the page hidden, the tile out of sight and no longer holding a copy', () => {
    arm();
    expect(takeOffReelCloseFlight()).toBe(true);
    expect(reelCloseFlightFlying.value).toEqual(PLAN);
    expect(reelCloseFlightHides.value).toBe(REEL);
    // What keeps UIKit's own ground from closing in on the tile.
    expect(reelCloseFlightSource.value).toBe('zoom|explore|post-1');
    expect(reelCloseFlightTime.value).toBe(0);
    expect(tileHidden).toBe(true);
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(false);
  });

  it('leaves a tile it covers all the way in sight, and still takes its copy of the picture away', () => {
    arm(PLAN, false);
    expect(takeOffReelCloseFlight()).toBe(true);
    expect(tileHidden).toBe(false);
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(false);
  });

  it('does not take off twice', () => {
    arm();
    expect(takeOffReelCloseFlight()).toBe(true);
    expect(takeOffReelCloseFlight()).toBe(false);
  });

  it('stands still in its first frame and then goes by the frames it is given', () => {
    arm();
    takeOffReelCloseFlight();
    runFrame(8);
    expect(reelCloseFlightTime.value).toBe(0);
    runFrame(8);
    expect(reelCloseFlightTime.value).toBeCloseTo(8 / REEL_CLOSE_FLIGHT_MS);
    runFrame(8);
    expect(reelCloseFlightTime.value).toBeCloseTo(16 / REEL_CLOSE_FLIGHT_MS);
  });

  // The pop holds the UI thread as it begins; the picture waits, it does not jump.
  it('takes a held frame as one step, however long it was', () => {
    arm();
    takeOffReelCloseFlight();
    runFrame(8);
    runFrame(400);
    expect(reelCloseFlightTime.value).toBeCloseTo(REEL_CLOSE_FLIGHT_MAX_STEP_MS / REEL_CLOSE_FLIGHT_MS);
  });

  it('lands: the tile shows again under the picture, which fades over it', () => {
    arm();
    takeOffReelCloseFlight();
    confirmReelCloseFlight(REEL);
    // Not before it is all but there.
    runFrame(8);
    runFrame(8);
    expect(tileHidden).toBe(true);
    const ran = runToLanding();
    // Well inside its time: the last hundredth of the way is not waited for.
    expect(ran).toBeLessThan(Math.floor(REEL_CLOSE_FLIGHT_MS / 8));
    expect(reelCloseFlightTravel(reelCloseFlightTime.value)).toBeGreaterThanOrEqual(REEL_CLOSE_FLIGHT_LANDS_AT);
    expect(tileHidden).toBe(false);
    // The double's `withTiming` is the value it is heading for.
    expect(reelCloseFlightPicture.value).toBe(0);
    // Still the layer's until it has faded, and still settling under the fade.
    expect(reelCloseFlightFlying.value).toEqual(PLAN);
    const landedAt = reelCloseFlightTime.value;
    runFrame(8);
    expect(reelCloseFlightTime.value).toBeGreaterThan(landedAt);
    vi.advanceTimersByTime(REEL_CLOSE_FLIGHT_LANDING_FADE_MS + 50);
    expect(reelCloseFlightFlying.value).toBeNull();
    // The frames it had asked for come to nothing once it is over.
    runFrame(8);
    expect(frames).toHaveLength(0);
    expect(reelCloseFlightSource.value).toBeNull();
    expect(reelCloseFlightPicture.value).toBe(1);
    // UIKit has yet to take the page away: it stays hidden until the reel goes.
    expect(reelCloseFlightHides.value).toBe(REEL);
    forgetReelCloseFlight(REEL);
    expect(reelCloseFlightHides.value).toBe(0);
    // Its picture stayed with the tile it landed in.
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(false);
  });

  it('tells the reel whether its picture is flying', () => {
    arm();
    expect(confirmReelCloseFlight(REEL)).toBe(false);
    takeOffReelCloseFlight();
    expect(confirmReelCloseFlight(REEL + 1)).toBe(false);
    expect(confirmReelCloseFlight(REEL)).toBe(true);
  });

  it('is called back when the press did not pop the reel: the page, the tile and its copy as they were', () => {
    arm();
    takeOffReelCloseFlight();
    runFrame(8);
    runFrame(8);
    vi.advanceTimersByTime(REEL_CLOSE_FLIGHT_UNCONFIRMED_MS);
    expect(reelCloseFlightFlying.value).toBeNull();
    expect(reelCloseFlightHides.value).toBe(0);
    expect(reelCloseFlightSource.value).toBeNull();
    expect(reelCloseFlightTime.value).toBe(0);
    expect(tileHidden).toBe(false);
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(true);
    // The frames it had asked for come to nothing.
    runFrame(8);
    expect(reelCloseFlightTime.value).toBe(0);
    expect(frames).toHaveLength(0);
    // And the next press flies.
    expect(takeOffReelCloseFlight()).toBe(true);
  });

  // The picture is on its tile some 230 ms after the press. Landing there with
  // nobody having said the reel was going left the reel on top with its page
  // hidden, taking every touch meant for the feed (review of #755).
  it('is called back at its landing too, if the navigator still has not said the reel is going', () => {
    arm();
    takeOffReelCloseFlight();
    runToLanding();
    expect(reelCloseFlightFlying.value).toBeNull();
    expect(reelCloseFlightHides.value).toBe(0);
    expect(reelCloseFlightSource.value).toBeNull();
    expect(tileHidden).toBe(false);
    expect(isAppleZoomReturnPictureHeld('explore', 'post-1')).toBe(true);
    // Nothing still pending hides it again.
    vi.advanceTimersByTime(REEL_CLOSE_FLIGHT_UNCONFIRMED_MS + REEL_CLOSE_FLIGHT_LANDING_FADE_MS + 50);
    expect(reelCloseFlightHides.value).toBe(0);
    expect(takeOffReelCloseFlight()).toBe(true);
  });

  it('gives up on the navigator well before the picture could land', () => {
    let landsAt = 0;
    while (reelCloseFlightTravel(landsAt / REEL_CLOSE_FLIGHT_MS) < REEL_CLOSE_FLIGHT_LANDS_AT) landsAt += 1;
    expect(REEL_CLOSE_FLIGHT_UNCONFIRMED_MS).toBeLessThanOrEqual(landsAt - 50);
  });

  it('is not called back once the navigator has said the reel is going', () => {
    arm();
    takeOffReelCloseFlight();
    confirmReelCloseFlight(REEL);
    vi.advanceTimersByTime(REEL_CLOSE_FLIGHT_UNCONFIRMED_MS * 2);
    expect(reelCloseFlightFlying.value).toEqual(PLAN);
    expect(reelCloseFlightHides.value).toBe(REEL);
  });

  it('keeps its picture while it flies, whatever its reel lets go of, and drops it once landed', () => {
    const spec = { key: 'k1', url: 'https://example.test/p.webp', cacheKey: null, from: FROM };
    offerReelCloseFlightPicture(spec);
    noteReelCloseFlightPictureDisplayed('k1');
    arm();
    takeOffReelCloseFlight();
    confirmReelCloseFlight(REEL);
    // The reel stops holding the picture as it leaves, and disarms.
    withdrawReelCloseFlightPicture('k1');
    disarmReelCloseFlight(REEL);
    expect(getReelCloseFlightPicture()).toEqual(spec);
    // Nor is another put in its place under it.
    offerReelCloseFlightPicture({ ...spec, key: 'k2' });
    expect(getReelCloseFlightPicture()).toEqual(spec);
    runToLanding();
    expect(getReelCloseFlightPicture()).toEqual(spec);
    vi.advanceTimersByTime(REEL_CLOSE_FLIGHT_LANDING_FADE_MS + 50);
    expect(getReelCloseFlightPicture()).toBeNull();
  });

  it('leaves nothing hidden when its reel goes before it has landed', () => {
    arm();
    takeOffReelCloseFlight();
    confirmReelCloseFlight(REEL);
    runFrame(8);
    runFrame(8);
    // UIKit took the reel away mid-flight.
    forgetReelCloseFlight(REEL);
    expect(reelCloseFlightHides.value).toBe(0);
    runToLanding();
    vi.advanceTimersByTime(REEL_CLOSE_FLIGHT_LANDING_FADE_MS + 50);
    expect(reelCloseFlightFlying.value).toBeNull();
    expect(reelCloseFlightSource.value).toBeNull();
    expect(reelCloseFlightHides.value).toBe(0);
    expect(tileHidden).toBe(false);
  });

  it('flies on when its reel is disarmed in the frame after', () => {
    arm();
    takeOffReelCloseFlight();
    disarmReelCloseFlight(REEL);
    confirmReelCloseFlight(REEL);
    runToLanding();
    expect(reelCloseFlightTravel(reelCloseFlightTime.value)).toBeGreaterThanOrEqual(REEL_CLOSE_FLIGHT_LANDS_AT);
    expect(tileHidden).toBe(false);
  });
});
