import { describe, expect, it } from 'vitest';

import {
  INITIAL_SHOWCASE_ACTIVATION_STATE,
  getVisibleCardItems,
  reduceShowcaseActivation,
  sameStringList,
  type ShowcaseActivationEvent,
  type ShowcaseActivationState,
} from '../lib/showcase-feed-activation';
import type { ShowcaseFeedItem } from '../lib/types';

function item(id: string, overrides: Partial<ShowcaseFeedItem> = {}) {
  return {
    id,
    title: id,
    body: '',
    prompt: '',
    category: 'video',
    mediaKind: 'video',
    mediaUrl: `https://cdn.example.com/${id}.mp4`,
    creator: { username: id },
    ...overrides,
  } as unknown as ShowcaseFeedItem;
}

const imageItem = (id: string) => item(id, { category: 'image', mediaKind: 'image' });

function run(events: ShowcaseActivationEvent[], start: ShowcaseActivationState = INITIAL_SHOWCASE_ACTIVATION_STATE) {
  return events.reduce((state, event) => reduceShowcaseActivation(state, event, 1), start);
}

const sawVideos = (items: ShowcaseFeedItem[]): ShowcaseActivationEvent => ({
  type: 'viewableItemsChanged',
  items,
});

describe('reduceShowcaseActivation', () => {
  it('elects on the first viewability report so a resting feed starts playing', () => {
    const state = run([sawVideos([item('a'), item('b')])]);

    expect(state.scroll).toBe('idle');
    expect(state.activeIds).toEqual(['a']);
  });

  it('buffers candidates without electing while the feed is in motion', () => {
    const state = run([
      sawVideos([item('a')]),
      { type: 'dragBegin' },
      sawVideos([item('b')]),
      { type: 'momentumBegin' },
      sawVideos([item('c')]),
    ]);

    // 'c' is staged, but 'a' is still the one playing: no mid-scroll handoff.
    expect(state.candidates.map((candidate) => candidate.id)).toEqual(['c']);
    expect(state.activeIds).toEqual(['a']);
  });

  it('holds the playing video when a new one appears above it', () => {
    const state = run([
      sawVideos([item('a')]),
      { type: 'dragBegin' },
      { type: 'dragEnd', velocityY: 2.4 },
      { type: 'momentumBegin' },
      // 'b' is now topmost, but 'a' is still on screen and still playing.
      sawVideos([item('b'), item('a')]),
      { type: 'momentumEnd' },
    ]);

    expect(state.scroll).toBe('idle');
    expect(state.activeIds).toEqual(['a']);
  });

  it('promotes the topmost video once the playing one leaves the viewport', () => {
    const state = run([
      sawVideos([item('a')]),
      { type: 'dragBegin' },
      { type: 'dragEnd', velocityY: 2.4 },
      { type: 'momentumBegin' },
      sawVideos([item('b'), item('c')]),
      { type: 'momentumEnd' },
    ]);

    expect(state.activeIds).toEqual(['b']);
  });

  it('elects immediately when a drag is released at rest', () => {
    const state = run([
      { type: 'dragBegin' },
      sawVideos([item('a')]),
      { type: 'dragEnd', velocityY: 0.02 },
    ]);

    expect(state.scroll).toBe('idle');
    expect(state.activeIds).toEqual(['a']);
  });

  it('waits for the confirm window when a drag is released with a fling', () => {
    const flung = run([
      { type: 'dragBegin' },
      sawVideos([item('a')]),
      { type: 'dragEnd', velocityY: 3.1 },
    ]);

    expect(flung.scroll).toBe('settling');
    expect(flung.activeIds).toEqual([]);

    // The timer fires only when momentum never arrived.
    const settled = reduceShowcaseActivation(flung, { type: 'settleTimeout' }, 1);
    expect(settled.scroll).toBe('idle');
    expect(settled.activeIds).toEqual(['a']);
  });

  it('treats an unreported drag-end velocity as a fling rather than as rest', () => {
    const state = run([
      { type: 'dragBegin' },
      sawVideos([item('a')]),
      { type: 'dragEnd' },
    ]);

    expect(state.scroll).toBe('settling');
    expect(state.activeIds).toEqual([]);
  });

  it('ignores a settle timeout that momentum already resolved', () => {
    const state = run([
      { type: 'dragBegin' },
      sawVideos([item('a')]),
      { type: 'dragEnd', velocityY: 3.1 },
      { type: 'momentumBegin' },
    ]);

    const stale = reduceShowcaseActivation(state, { type: 'settleTimeout' }, 1);
    expect(stale).toBe(state);
    expect(stale.activeIds).toEqual([]);
  });

  it('does not elect when an old fling expires under a new finger', () => {
    const state = run([
      sawVideos([item('a')]),
      { type: 'dragBegin' },
      { type: 'dragEnd', velocityY: 4 },
      { type: 'momentumBegin' },
      sawVideos([item('b')]),
      // The user grabs the feed again mid-fling.
      { type: 'dragBegin' },
      { type: 'momentumEnd' },
    ]);

    expect(state.scroll).toBe('dragging');
    expect(state.activeIds).toEqual(['a']);
  });

  it('ignores a drag-end that arrives without a matching drag-begin', () => {
    const start = run([sawVideos([item('a')])]);
    const state = reduceShowcaseActivation(start, { type: 'dragEnd', velocityY: 0 }, 1);

    expect(state).toBe(start);
  });

  it('survives an idle reorder, such as a masonry relayout, without a handoff', () => {
    const start = run([sawVideos([item('a'), item('b')])]);
    const state = reduceShowcaseActivation(start, sawVideos([item('b'), item('a')]), 1);

    // Reordering must not restart playback: 'a' is still on screen.
    expect(state.activeIds).toBe(start.activeIds);
  });

  it('re-elects on an idle viewability change that drops the playing video', () => {
    const start = run([sawVideos([item('a'), item('b')])]);
    const state = reduceShowcaseActivation(start, sawVideos([item('b')]), 1);

    expect(state.activeIds).toEqual(['b']);
  });

  it('stops playback when a settled viewport holds no video', () => {
    const state = run([
      sawVideos([item('a')]),
      { type: 'dragBegin' },
      { type: 'dragEnd', velocityY: 0 },
      sawVideos([imageItem('x'), imageItem('y')]),
    ]);

    expect(state.activeIds).toEqual([]);
  });

  it('keeps the previous array when an election changes nothing', () => {
    const start = run([sawVideos([item('a')])]);
    const state = reduceShowcaseActivation(start, sawVideos([item('a')]), 1);

    expect(state.activeIds).toBe(start.activeIds);
  });

  it('clears everything on reset', () => {
    const start = run([sawVideos([item('a')]), { type: 'dragBegin' }]);
    const state = reduceShowcaseActivation(start, { type: 'reset' }, 1);

    expect(state).toEqual(INITIAL_SHOWCASE_ACTIVATION_STATE);
  });
});

describe('getVisibleCardItems', () => {
  it('keeps only viewable tokens that carry a card', () => {
    const a = item('a');
    const b = item('b');
    const items = getVisibleCardItems([
      { isViewable: true, item: { item: a } },
      { isViewable: false, item: { item: b } },
      { isViewable: true, item: undefined },
    ] as never);

    expect(items).toEqual([a]);
  });
});

describe('sameStringList', () => {
  it('compares length and order', () => {
    expect(sameStringList(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameStringList(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameStringList(['a'], ['a', 'b'])).toBe(false);
  });
});
