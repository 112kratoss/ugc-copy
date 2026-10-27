import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHomeShelfRowRest } from '../lib/home-shelf-row-rest';
import { SHOWCASE_SETTLE_CONFIRM_MS } from '../lib/showcase-feed-activation';

const at = (x: number, targetX?: number) => ({
  contentOffset: { x, y: 0 },
  layoutMeasurement: { width: 390, height: 300 },
  ...(targetX === undefined ? {} : { targetContentOffset: { x: targetX, y: 0 } }),
});

describe('when the shelf row has come to rest', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is the end of the momentum that follows a lift, where it ends', () => {
    const onRest = vi.fn();
    const row = createHomeShelfRowRest(onRest);
    row.dragBegin();
    row.dragEnd(at(120));
    row.momentumBegin();
    vi.advanceTimersByTime(SHOWCASE_SETTLE_CONFIRM_MS * 2);
    expect(onRest).not.toHaveBeenCalled();

    row.momentumEnd(at(161));
    expect(onRest).toHaveBeenCalledExactlyOnceWith({ scrollX: 161, viewportWidth: 390 });
  });

  it('is a lift no momentum follows within the confirm window, where the snap lands', () => {
    const onRest = vi.fn();
    const row = createHomeShelfRowRest(onRest);
    row.dragBegin();
    row.dragEnd(at(150, 161));
    vi.advanceTimersByTime(SHOWCASE_SETTLE_CONFIRM_MS - 1);
    expect(onRest).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRest).toHaveBeenCalledExactlyOnceWith({ scrollX: 161, viewportWidth: 390 });
  });

  it('is a scroll with no finger in it once its events stop, and never the scroll events of a drag or a coast', () => {
    const onRest = vi.fn();
    const row = createHomeShelfRowRest(onRest);
    // TalkBack moving to a card off screen: scroll events, and nothing else.
    row.scrolled(at(80));
    vi.advanceTimersByTime(SHOWCASE_SETTLE_CONFIRM_MS - 1);
    row.scrolled(at(161));
    vi.advanceTimersByTime(SHOWCASE_SETTLE_CONFIRM_MS - 1);
    expect(onRest).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRest).toHaveBeenCalledExactlyOnceWith({ scrollX: 161, viewportWidth: 390 });

    onRest.mockClear();
    row.dragBegin();
    row.scrolled(at(200));
    row.dragEnd(at(230));
    row.momentumBegin();
    row.scrolled(at(280));
    vi.advanceTimersByTime(SHOWCASE_SETTLE_CONFIRM_MS * 2);
    expect(onRest).not.toHaveBeenCalled();
    row.momentumEnd(at(322));
    expect(onRest).toHaveBeenCalledExactlyOnceWith({ scrollX: 322, viewportWidth: 390 });
  });

  it('is never a momentum end under a finger back on the row, nor a lift cancelled by a new drag or unmount', () => {
    const onRest = vi.fn();
    const row = createHomeShelfRowRest(onRest);
    row.dragBegin();
    row.dragEnd(at(120));
    row.momentumBegin();
    // The finger lands again while the last fling coasts out.
    row.dragBegin();
    row.momentumEnd(at(140));
    expect(onRest).not.toHaveBeenCalled();

    row.dragEnd(at(161));
    row.dragBegin();
    vi.advanceTimersByTime(SHOWCASE_SETTLE_CONFIRM_MS);
    row.dragEnd(at(322));
    row.cancel();
    vi.advanceTimersByTime(SHOWCASE_SETTLE_CONFIRM_MS);
    expect(onRest).not.toHaveBeenCalled();
  });
});
