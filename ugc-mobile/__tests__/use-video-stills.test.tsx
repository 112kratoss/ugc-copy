(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type GrabOptions = { signal: AbortSignal; alreadyRead?: () => unknown };

// The still a link gives, decided per case. Like the real queue, each read
// waits for the one before, and takes a still read meanwhile by another row
// (`alreadyRead`) instead of making its own.
const stills = vi.hoisted(() => {
  const state = {
    read: true,
    answer: (async (url: string) => ({ name: url })) as (url: string, options: GrabOptions) => Promise<unknown>,
    // Every read made, by link: a read that took another row's still makes none.
    made: [] as string[],
    queue: Promise.resolve() as Promise<unknown>,
    grab: vi.fn((url: string, options: GrabOptions) => {
      const turn = state.queue.then(async () => {
        if (options.signal.aborted) return null;
        const ready = options.alreadyRead?.();
        if (ready) return ready;
        state.made.push(url);
        return state.answer(url, options);
      });
      state.queue = turn.catch(() => undefined);
      return turn;
    }),
  };
  return state;
});
vi.mock('@/lib/video-frame', () => ({
  grabVideoFrame: stills.grab,
  get VIDEO_STILLS_READ() { return stills.read; },
}));

import { useVideoStills, type StillClip } from '@/lib/use-video-stills';
import { cacheVideoStill, cachedVideoStill, clearVideoStills } from '@/lib/video-still-cache';

type Shown = Record<string, unknown>;
type Hook = ReturnType<typeof useVideoStills>;

function Row({ clips, read, onRender }: { clips: StillClip[]; read?: boolean; onRender: (hook: Hook) => void }) {
  onRender(useVideoStills(clips, { read }));
  return null;
}

/** Renders a row and keeps what it drew, first and last, and its `readAgain`. */
async function mount(clips: StillClip[], read?: boolean) {
  const drawn: Hook[] = [];
  const onRender = (hook: Hook) => { drawn.push(hook); };
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => { tree = renderer.create(<Row clips={clips} read={read} onRender={onRender} />); });
  return {
    tree,
    first: (): Shown => drawn[0].stills,
    last: (): Shown => drawn[drawn.length - 1].stills,
    drawnAll: (): Shown[] => drawn.map((hook) => hook.stills),
    readAgain: (key: string) => renderer.act(async () => { drawn[drawn.length - 1].readAgain(key); }),
    update: (next: StillClip[], nextRead?: boolean) => renderer.act(async () => {
      tree.update(<Row clips={next} read={nextRead} onRender={onRender} />);
    }),
  };
}

const clip = (key: string, url: string | null = `https://cdn.test/${key}.mp4`): StillClip => ({ key, url });
const still = (name: string) => ({ name });

beforeEach(() => {
  stills.read = true;
  stills.made.length = 0;
  stills.answer = async (url) => still(url);
  stills.grab.mockClear();
  stills.queue = Promise.resolve();
  clearVideoStills();
});

describe('useVideoStills', () => {
  it('reads each clip once its link arrives, and keeps its still when the link is renewed', async () => {
    const row = await mount([clip('a', null)]);
    expect(stills.made).toEqual([]);

    await row.update([clip('a', 'https://cdn.test/a.mp4')]);
    expect(stills.made).toEqual(['https://cdn.test/a.mp4']);
    expect(row.last()).toEqual({ a: still('https://cdn.test/a.mp4') });

    await row.update([clip('a', 'https://cdn.test/renewed/a.mp4')]);
    expect(stills.made).toHaveLength(1);
    expect(row.last()).toEqual({ a: still('https://cdn.test/a.mp4') });
  });

  it('reads a clip that gave none again only when its card asks, from the link it has then', async () => {
    stills.answer = async () => null;
    const row = await mount([clip('a')]);
    expect(row.last()).toEqual({ a: null });

    // A record read again for any other reason renews the link: not asked again.
    await row.update([clip('a', 'https://cdn.test/renewed/a.mp4')]);
    expect(stills.made).toHaveLength(1);

    stills.answer = async (url) => still(url);
    await row.readAgain('a');
    expect(stills.made).toEqual(['https://cdn.test/a.mp4', 'https://cdn.test/renewed/a.mp4']);
    expect(row.last()).toEqual({ a: still('https://cdn.test/renewed/a.mp4') });

    // Asking again for a clip that has its still reads nothing.
    await row.readAgain('a');
    expect(stills.made).toHaveLength(2);
  });

  it('reads a clip that gave none again when asked, even from a link that reads the same', async () => {
    stills.answer = async () => null;
    const row = await mount([clip('a')]);
    stills.answer = async (url) => still(url);

    await row.readAgain('a');
    expect(stills.made).toEqual(['https://cdn.test/a.mp4', 'https://cdn.test/a.mp4']);
    expect(row.last()).toEqual({ a: still('https://cdn.test/a.mp4') });
  });

  it('reads a clip again from its renewed link when its card opened mid-read and that read gave none', async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    stills.answer = () => new Promise((resolve) => { answerFirst = resolve; });
    const row = await mount([clip('a')]);

    // The card is opened before its still is in: the open renews its link and asks again.
    await row.update([clip('a', 'https://cdn.test/renewed/a.mp4')]);
    await row.readAgain('a');
    expect(stills.made).toEqual(['https://cdn.test/a.mp4']);

    stills.answer = async (url) => still(url);
    await renderer.act(async () => { answerFirst(null); });
    expect(stills.made).toEqual(['https://cdn.test/a.mp4', 'https://cdn.test/renewed/a.mp4']);
    expect(row.last()).toEqual({ a: still('https://cdn.test/renewed/a.mp4') });
  });

  it('reads nothing more for a card opened mid-read whose read then gives a still', async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    stills.answer = () => new Promise((resolve) => { answerFirst = resolve; });
    const row = await mount([clip('a')]);

    await row.readAgain('a');
    await renderer.act(async () => { answerFirst(still('first')); });
    expect(stills.made).toEqual(['https://cdn.test/a.mp4']);
    expect(row.last()).toEqual({ a: still('first') });
  });

  it('reads a file named twice under two links once, whatever it gives', async () => {
    stills.answer = async () => null;
    const row = await mount([clip('a', 'https://cdn.test/one/a.mp4'), clip('a', 'https://cdn.test/two/a.mp4')]);
    await row.update([clip('a', 'https://cdn.test/one/a.mp4'), clip('a', 'https://cdn.test/two/a.mp4')]);

    expect(stills.made).toEqual(['https://cdn.test/one/a.mp4']);
    expect(row.last()).toEqual({ a: null });
  });

  it('reads a file two rows name once, and both draw its still', async () => {
    // Both rows mount together (the recipe's and the creation's on one page), so both reads are queued at once.
    const drawn: Record<'first' | 'second', Hook[]> = { first: [], second: [] };
    await renderer.act(async () => {
      renderer.create(
        <>
          <Row clips={[clip('a', 'https://cdn.test/first/a.mp4')]} onRender={(hook) => { drawn.first.push(hook); }} />
          <Row clips={[clip('a', 'https://cdn.test/second/a.mp4')]} onRender={(hook) => { drawn.second.push(hook); }} />
        </>
      );
    });

    expect(stills.grab.mock.calls).toHaveLength(2);
    expect(stills.made).toEqual(['https://cdn.test/first/a.mp4']);
    expect(drawn.first[drawn.first.length - 1].stills).toEqual({ a: still('https://cdn.test/first/a.mp4') });
    expect(drawn.second[drawn.second.length - 1].stills).toEqual({ a: still('https://cdn.test/first/a.mp4') });
  });

  it('takes the still another row read meanwhile, where its own read gave none', async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    stills.answer = () => new Promise((resolve) => { answerFirst = resolve; });
    const first = await mount([clip('a')]);
    // The other row's still arrives while this row's read is still under way.
    cacheVideoStill('a', still('from the other row') as never);

    await renderer.act(async () => { answerFirst(null); });
    expect(first.last()).toEqual({ a: still('from the other row') });
    // Straight to the still: the card never blinks back to its plain mark.
    expect(first.drawnAll().some((shown) => shown.a === null)).toBe(false);
  });

  it('reads nothing while told not to, calls off a read under way, and keeps the stills it has', async () => {
    const signals: AbortSignal[] = [];
    stills.answer = (url, { signal }) => {
      signals.push(signal);
      return url.endsWith('b.mp4') ? new Promise(() => undefined) : Promise.resolve(still(url));
    };
    const row = await mount([clip('a'), clip('b')], false);
    expect(stills.made).toEqual([]);

    await row.update([clip('a'), clip('b')], true);
    expect(row.last()).toEqual({ a: still('https://cdn.test/a.mp4') });
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);

    await row.update([clip('a'), clip('b')], false);
    expect(signals.map((signal) => signal.aborted)).toEqual([false, true]);
    expect(row.last()).toEqual({ a: still('https://cdn.test/a.mp4') });

    renderer.act(() => row.tree.unmount());
  });

  it('draws a still read on an earlier visit from the first render, and reads its clip no more', async () => {
    const visit = await mount([clip('a')]);
    renderer.act(() => visit.tree.unmount());
    expect(stills.made).toHaveLength(1);

    // Off screen (the reel mounts a page beside its slide) and with no link yet.
    const again = await mount([clip('a', null)], false);
    expect(again.first()).toEqual({ a: still('https://cdn.test/a.mp4') });
    await again.update([clip('a')], true);
    expect(stills.made).toHaveLength(1);
  });

  it('keeps only the last few stills from one visit to the next, the least recently drawn going first', async () => {
    const keys = Array.from({ length: 8 }, (_, index) => `clip-${index}`);
    const visit = await mount(keys.map((key) => clip(key)));
    renderer.act(() => visit.tree.unmount());
    // clip-0, read first, is drawn again, so clip-1 is now the least recently drawn.
    const again = await mount([clip('clip-0')]);
    renderer.act(() => again.tree.unmount());

    const another = await mount([clip('clip-8')]);
    renderer.act(() => another.tree.unmount());
    expect(cachedVideoStill('clip-0')).toEqual(still('https://cdn.test/clip-0.mp4'));
    expect(cachedVideoStill('clip-1')).toBeUndefined();
    expect(stills.made).toHaveLength(9);
  });

  it('does not keep a still that lands after its read was called off', async () => {
    let answer: (value: unknown) => void = () => undefined;
    stills.answer = () => new Promise((resolve) => { answer = resolve; });
    const visit = await mount([clip('a')]);
    renderer.act(() => visit.tree.unmount());
    await renderer.act(async () => { answer(still('late')); });

    stills.answer = async (url) => still(url);
    const again = await mount([clip('a')]);
    expect(again.first()).toEqual({});
    expect(again.last()).toEqual({ a: still('https://cdn.test/a.mp4') });
  });

  it('puts no still back in the cache once a sign-out has cleared it, from a read begun before', async () => {
    let answer: (value: unknown) => void = () => undefined;
    stills.answer = () => new Promise((resolve) => { answer = resolve; });
    await mount([clip('a')]);

    // The person signs out while a row that is still mounted is reading.
    clearVideoStills();
    await renderer.act(async () => { answer(still('theirs')); });

    expect(cachedVideoStill('a')).toBeUndefined();
  });

  it('reads nothing where this binary reads no stills', async () => {
    stills.read = false;
    const row = await mount([clip('a')]);
    expect(stills.grab.mock.calls).toHaveLength(0);
    expect(row.last()).toEqual({});
  });
});

describe('the still cache', () => {
  it('is cleared everywhere the signed-in session is cleared from the device', () => {
    const auth = readFileSync(resolve(__dirname, '..', 'lib/auth.tsx'), 'utf8');
    const count = (needle: string) => auth.split(needle).length - 1;

    expect(count('clearPersistedSupabaseAuthSession()')).toBeGreaterThan(0);
    expect(count('clearVideoStills()')).toBe(count('clearPersistedSupabaseAuthSession()'));
  });
});
