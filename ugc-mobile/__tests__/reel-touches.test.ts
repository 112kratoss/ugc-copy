import { describe, expect, it, vi } from 'vitest';

import { createReelTouches } from '../lib/reel-touches';

/** A touch event with `count` fingers still on the screen after it. */
const fingers = (count: number) => ({ nativeEvent: { touches: { length: count } } });

describe('whether a finger is on the reel', () => {
  it('is on from the first contact to the last lift, and says when that was', () => {
    let clock = 1000;
    const touches = createReelTouches(() => clock);
    expect(touches.active()).toBe(false);
    expect(touches.endedAt()).toBeNull();

    touches.handlers.onTouchStart(fingers(1));
    expect(touches.active()).toBe(true);

    // A second finger down, and one of the two lifted: still held.
    touches.handlers.onTouchStart(fingers(2));
    clock = 1200;
    touches.handlers.onTouchEnd(fingers(1));
    expect(touches.active()).toBe(true);
    expect(touches.endedAt()).toBeNull();

    clock = 1500;
    touches.handlers.onTouchEnd(fingers(0));
    expect(touches.active()).toBe(false);
    expect(touches.endedAt()).toBe(1500);
  });

  it('tells its listeners when the last finger leaves, a cancelled touch included', () => {
    let clock = 0;
    const touches = createReelTouches(() => clock);
    const heard = vi.fn();
    const stop = touches.subscribe(heard);

    touches.handlers.onTouchStart(fingers(1));
    expect(heard).not.toHaveBeenCalled();
    clock = 40;
    touches.handlers.onTouchCancel(fingers(0));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(touches.endedAt()).toBe(40);

    // A lift it never saw the start of is no lift.
    touches.handlers.onTouchEnd(fingers(0));
    expect(heard).toHaveBeenCalledTimes(1);

    stop();
    touches.handlers.onTouchStart(fingers(1));
    touches.handlers.onTouchEnd(fingers(0));
    expect(heard).toHaveBeenCalledTimes(1);
  });

  // React Native cancels a touch a gesture outside it takes over, and that
  // finger may still be on the glass: the landing cue asks.
  it('says whether the last finger left by a cancel or a lift', () => {
    const touches = createReelTouches(() => 0);
    expect(touches.endedByCancel()).toBe(false);

    touches.handlers.onTouchStart(fingers(1));
    touches.handlers.onTouchCancel(fingers(0));
    expect(touches.endedByCancel()).toBe(true);

    // A new touch that lifts.
    touches.handlers.onTouchStart(fingers(1));
    touches.handlers.onTouchEnd(fingers(0));
    expect(touches.endedByCancel()).toBe(false);

    // Two fingers, one cancelled and the other lifted last: a lift.
    touches.handlers.onTouchStart(fingers(2));
    touches.handlers.onTouchCancel(fingers(1));
    touches.handlers.onTouchEnd(fingers(0));
    expect(touches.endedByCancel()).toBe(false);
  });
});
