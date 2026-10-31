(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The still a link gives, decided per case.
const stills = vi.hoisted(() => ({
  read: true,
  grab: vi.fn<(url: string, options: { signal: AbortSignal }) => Promise<unknown>>(),
}));
vi.mock('@/lib/video-frame', () => ({
  grabVideoFrame: stills.grab,
  get VIDEO_STILLS_READ() { return stills.read; },
}));

import { resetVideoStillsForTests, useVideoStills, type StillClip } from '@/lib/use-video-stills';

type Shown = Record<string, unknown>;

function Row({ clips, read, onStills }: { clips: StillClip[]; read?: boolean; onStills: (shown: Shown) => void }) {
  onStills(useVideoStills(clips, { read }));
  return null;
}

/** Renders a row and keeps what it last drew, and what it drew first. */
async function mount(clips: StillClip[], read?: boolean) {
  const drawn: Shown[] = [];
  const onStills = (shown: Shown) => { drawn.push(shown); };
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => { tree = renderer.create(<Row clips={clips} read={read} onStills={onStills} />); });
  return {
    tree,
    first: () => drawn[0],
    last: () => drawn[drawn.length - 1],
    update: (next: StillClip[], nextRead?: boolean) => renderer.act(async () => {
      tree.update(<Row clips={next} read={nextRead} onStills={onStills} />);
    }),
  };
}

const clip = (key: string, url: string | null = `https://cdn.test/${key}.mp4`): StillClip => ({ key, url });
const still = (name: string) => ({ name });

beforeEach(() => {
  stills.read = true;
  stills.grab.mockReset();
  stills.grab.mockImplementation(async (url) => still(url));
  resetVideoStillsForTests();
});

describe('useVideoStills', () => {
  it('reads each clip once its link arrives, and keeps its still by key when the link is renewed', async () => {
    const row = await mount([clip('a', null)]);
    expect(stills.grab).not.toHaveBeenCalled();

    await row.update([clip('a', 'https://cdn.test/a.mp4')]);
    expect(stills.grab).toHaveBeenCalledWith('https://cdn.test/a.mp4', { signal: expect.any(AbortSignal) });
    expect(row.last()).toEqual({ a: still('https://cdn.test/a.mp4') });

    await row.update([clip('a', 'https://cdn.test/renewed/a.mp4')]);
    expect(stills.grab).toHaveBeenCalledTimes(1);
    expect(row.last()).toEqual({ a: still('https://cdn.test/a.mp4') });
  });

  it('reads a clip whose link gave none again only from another link', async () => {
    stills.grab.mockResolvedValueOnce(null);
    const row = await mount([clip('a')]);
    expect(row.last()).toEqual({ a: null });

    await row.update([clip('a')]);
    expect(stills.grab).toHaveBeenCalledTimes(1);

    await row.update([clip('a', 'https://cdn.test/renewed/a.mp4')]);
    expect(stills.grab).toHaveBeenCalledTimes(2);
    expect(row.last()).toEqual({ a: still('https://cdn.test/renewed/a.mp4') });
  });

  it('asks again from a link renewed while a read that gives none is under way', async () => {
    let answer: (value: unknown) => void = () => undefined;
    stills.grab.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const row = await mount([clip('a')]);
    await row.update([clip('a', 'https://cdn.test/renewed/a.mp4')]);
    expect(stills.grab).toHaveBeenCalledTimes(1);

    await renderer.act(async () => { answer(null); });
    expect(stills.grab).toHaveBeenCalledTimes(2);
    expect(stills.grab).toHaveBeenLastCalledWith('https://cdn.test/renewed/a.mp4', { signal: expect.any(AbortSignal) });
    expect(row.last()).toEqual({ a: still('https://cdn.test/renewed/a.mp4') });
  });

  it('reads nothing while told not to, calls off a read under way, and keeps the stills it has', async () => {
    const signals: AbortSignal[] = [];
    stills.grab.mockImplementation(async (url, { signal }) => {
      signals.push(signal);
      return url.endsWith('b.mp4') ? new Promise(() => undefined) : still(url);
    });
    const row = await mount([clip('a'), clip('b')], false);
    expect(stills.grab).not.toHaveBeenCalled();

    await row.update([clip('a'), clip('b')], true);
    expect(row.last()).toEqual({ a: still('https://cdn.test/a.mp4') });
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);

    await row.update([clip('a'), clip('b')], false);
    expect(signals.map((signal) => signal.aborted)).toEqual([false, true]);
    expect(row.last()).toEqual({ a: still('https://cdn.test/a.mp4') });

    await row.update([clip('a'), clip('b')], true);
    expect(stills.grab.mock.calls.map(([url]) => url)).toEqual([
      'https://cdn.test/a.mp4', 'https://cdn.test/b.mp4', 'https://cdn.test/b.mp4',
    ]);
    renderer.act(() => row.tree.unmount());
    expect(signals[2].aborted).toBe(true);
  });

  it('draws a still read on an earlier visit from the first render, and reads its clip no more', async () => {
    const visit = await mount([clip('a')]);
    renderer.act(() => visit.tree.unmount());
    expect(stills.grab).toHaveBeenCalledTimes(1);

    // Off screen (the reel mounts a page beside its slide) and with no link yet.
    const again = await mount([clip('a', null)], false);
    expect(again.first()).toEqual({ a: still('https://cdn.test/a.mp4') });
    await again.update([clip('a')], true);
    expect(stills.grab).toHaveBeenCalledTimes(1);
  });

  it('keeps only the last few stills from one visit to the next', async () => {
    const keys = Array.from({ length: 9 }, (_, index) => `clip-${index}`);
    const visit = await mount(keys.map((key) => clip(key)));
    renderer.act(() => visit.tree.unmount());
    expect(stills.grab).toHaveBeenCalledTimes(9);

    const again = await mount(keys.map((key) => clip(key)));
    // The oldest was let go; the eight after it are drawn at once.
    expect(Object.keys(again.first()).sort()).toEqual(keys.slice(1).sort());
    expect(stills.grab).toHaveBeenCalledTimes(10);
    expect(stills.grab).toHaveBeenLastCalledWith('https://cdn.test/clip-0.mp4', { signal: expect.any(AbortSignal) });
  });

  it('does not keep a still that lands after its read was called off', async () => {
    let answer: (value: unknown) => void = () => undefined;
    stills.grab.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const visit = await mount([clip('a')]);
    renderer.act(() => visit.tree.unmount());
    await renderer.act(async () => { answer(still('late')); });

    const again = await mount([clip('a')]);
    expect(again.first()).toEqual({});
    expect(stills.grab).toHaveBeenCalledTimes(2);
  });

  it('reads one still for a file two cards name', async () => {
    const row = await mount([clip('a'), clip('a')]);
    expect(stills.grab).toHaveBeenCalledTimes(1);
    expect(row.last()).toEqual({ a: still('https://cdn.test/a.mp4') });
  });

  it('reads nothing where this binary reads no stills', async () => {
    stills.read = false;
    const row = await mount([clip('a')]);
    expect(stills.grab).not.toHaveBeenCalled();
    expect(row.last()).toEqual({});
  });
});
