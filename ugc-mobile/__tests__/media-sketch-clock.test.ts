import { describe, expect, it, vi } from 'vitest';

import { createListMotion, createSketchClock } from '../lib/media-sketch-clock';

function clock() {
  const drive = { start: vi.fn(), stop: vi.fn() };
  return { drive, sketches: createSketchClock(drive) };
}

describe('the loading sketches’ clock', () => {
  it('runs while a sketch is on screen, once for any number of them', () => {
    const { drive, sketches } = clock();
    const first = sketches.retain();
    const second = sketches.retain();
    expect(drive.start).toHaveBeenCalledTimes(1);
    expect(sketches.isRunning()).toBe(true);

    first();
    expect(drive.stop).not.toHaveBeenCalled();
    second();
    expect(drive.stop).toHaveBeenCalledTimes(1);
    expect(sketches.isRunning()).toBe(false);
  });

  // On Android every frame of a running clock redraws each sketch into a new
  // bitmap; held while a list moves, no sketch changes during the fling.
  it('stands still while a list moves, and starts again once every list rests', () => {
    const { drive, sketches } = clock();
    sketches.retain();
    const grid = sketches.hold();
    const other = sketches.hold();
    expect(drive.stop).toHaveBeenCalledTimes(1);

    grid();
    expect(drive.start).toHaveBeenCalledTimes(1);
    other();
    expect(drive.start).toHaveBeenCalledTimes(2);
    expect(sketches.isRunning()).toBe(true);
  });

  it('starts no clock for a sketch mounted while a list moves, until it rests', () => {
    const { drive, sketches } = clock();
    const moving = sketches.hold();
    sketches.retain();
    expect(drive.start).not.toHaveBeenCalled();
    moving();
    expect(drive.start).toHaveBeenCalledTimes(1);
  });

  it('counts each release once', () => {
    const { drive, sketches } = clock();
    sketches.retain();
    const moving = sketches.hold();
    const another = sketches.hold();
    moving();
    moving();
    expect(drive.start).toHaveBeenCalledTimes(1);
    another();
    expect(drive.start).toHaveBeenCalledTimes(2);
  });
});

describe('a list’s motion', () => {
  function motion() {
    const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
    const onMove = vi.fn();
    const onRest = vi.fn();
    const list = createListMotion({
      settleMs: 120,
      onMove,
      onRest,
      schedule: (run, ms) => {
        const timer = { run, ms, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      },
    });
    const fire = () => timers.filter((timer) => !timer.cancelled).forEach((timer) => {
      timer.cancelled = true;
      timer.run();
    });
    return { list, onMove, onRest, timers, fire };
  }

  it('moves from a drag until the momentum after it ends', () => {
    const { list, onMove, onRest, fire } = motion();
    list.report('dragBegin');
    list.report('dragEnd');
    list.report('momentumBegin');
    fire();
    expect(onRest).not.toHaveBeenCalled();
    list.report('momentumEnd');
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onRest).toHaveBeenCalledTimes(1);
  });

  it('rests a moment after a drag let go with no momentum (iOS)', () => {
    const { list, onRest, timers, fire } = motion();
    list.report('dragBegin');
    list.report('dragEnd');
    expect(onRest).not.toHaveBeenCalled();
    expect(timers.at(-1)?.ms).toBe(120);
    fire();
    expect(onRest).toHaveBeenCalledTimes(1);
  });

  it('keeps moving when a finger lands on a list still coasting', () => {
    const { list, onMove, onRest } = motion();
    list.report('dragBegin');
    list.report('dragEnd');
    list.report('momentumBegin');
    list.report('dragBegin');
    list.report('momentumEnd');
    expect(onRest).toHaveBeenCalledTimes(1);
    list.report('dragBegin');
    expect(onMove).toHaveBeenCalledTimes(2);
  });

  it('ignores an end with no start, and rests when the list goes away', () => {
    const { list, onMove, onRest } = motion();
    list.report('dragEnd');
    list.report('momentumEnd');
    expect(onMove).not.toHaveBeenCalled();
    expect(onRest).not.toHaveBeenCalled();

    list.report('momentumBegin');
    list.dispose();
    expect(onRest).toHaveBeenCalledTimes(1);
    list.dispose();
    expect(onRest).toHaveBeenCalledTimes(1);
  });
});
