import { describe, expect, it, vi } from 'vitest';

// The policy table only: the live network hook would pull react-native in.
vi.mock('@/lib/playback-device', () => ({ useNetworkKind: () => 'unknown' }));

import { resolveAutoplayPolicy } from '../lib/autoplay-preference';
import { SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS } from '../lib/media-performance';
import {
  INITIAL_SHOWCASE_ACTIVATION_STATE,
  getVisibleCardItems,
  reduceShowcaseActivation,
  sameStringList,
  selectPreparedActivationIds,
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

  it('elects a drawn card while moving when asked to, and holds the one playing', () => {
    const ready = new Set(['b']);
    const isReady = (candidate: ShowcaseFeedItem) => ready.has(candidate.id);
    const moving = [sawVideos([item('a')]), { type: 'dragBegin' } as const]
      .reduce((state, event) => reduceShowcaseActivation(state, event, 1, isReady), INITIAL_SHOWCASE_ACTIVATION_STATE);

    // 'c' has no player yet: the slot stays with 'a' while it is still on screen…
    const held = reduceShowcaseActivation(moving, sawVideos([item('c'), item('a')]), 1, isReady);
    expect(held.activeIds).toBe(moving.activeIds);
    // …and empties once 'a' leaves, rather than mounting 'c' mid-scroll.
    const waiting = reduceShowcaseActivation(held, sawVideos([item('c')]), 1, isReady);
    expect(waiting.activeIds).toEqual([]);
    // A drawn player is a resume: 'b' starts at once.
    const resumed = reduceShowcaseActivation(waiting, sawVideos([item('b'), item('c')]), 1, isReady);
    expect(resumed.activeIds).toEqual(['b']);
    // Rest elects among everyone, as before.
    const rested = reduceShowcaseActivation(waiting, { type: 'dragEnd', velocityY: 0 }, 1, isReady);
    expect(rested.activeIds).toEqual(['c']);
  });

  it('still buffers in motion for a feed that passes no readiness', () => {
    const moving = run([sawVideos([item('a')]), { type: 'dragBegin' }, sawVideos([item('b')])]);
    expect(moving.activeIds).toEqual(['a']);
  });

  it('clears everything on reset', () => {
    const start = run([sawVideos([item('a')]), { type: 'dragBegin' }]);
    const state = reduceShowcaseActivation(start, { type: 'reset' }, 1);

    expect(state).toEqual(INITIAL_SHOWCASE_ACTIVATION_STATE);
  });
});

describe('the autoplay policy in the election (D3)', () => {
  /** What a screen dispatches from `useAutoplayPolicy()`. */
  function policy(preference: 'wifi' | 'always' | 'never', network: 'wifi' | 'cellular' | 'unknown'): ShowcaseActivationEvent {
    const { electOnlyAtRest, preparedLimit } = resolveAutoplayPolicy(preference, network);
    return { type: 'policyChanged', electOnlyAtRest, preparedLimit };
  }

  const everyCardDrawn = () => true;
  const feed = [item('a'), item('b'), item('c'), item('d')];

  function step(state: ShowcaseActivationState, event: ShowcaseActivationEvent) {
    return reduceShowcaseActivation(state, event, 1, everyCardDrawn);
  }

  it('starts at the feed as it was: handoffs in motion and two prepared neighbours', () => {
    expect(INITIAL_SHOWCASE_ACTIVATION_STATE.electOnlyAtRest).toBe(false);
    expect(INITIAL_SHOWCASE_ACTIVATION_STATE.preparedLimit).toBe(SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS);
    // Always, and Wi-Fi only off mobile data, change nothing.
    for (const event of [policy('always', 'cellular'), policy('wifi', 'wifi'), policy('wifi', 'unknown')]) {
      expect(reduceShowcaseActivation(INITIAL_SHOWCASE_ACTIVATION_STATE, event, 1)).toBe(INITIAL_SHOWCASE_ACTIVATION_STATE);
    }
  });

  it('on mobile data under Wi-Fi only, elects only once the feed rests, even a drawn card', () => {
    const playing = [sawVideos([item('a')]), policy('wifi', 'cellular'), { type: 'dragBegin' } as const]
      .reduce(step, INITIAL_SHOWCASE_ACTIVATION_STATE);
    expect(playing.activeIds).toEqual(['a']);

    // On Wi-Fi this report hands the slot to 'b' at once; here it only stages it.
    const passing = step(playing, sawVideos([item('b')]));
    expect(passing.activeIds).toEqual(['a']);
    expect(step(passing, { type: 'dragEnd', velocityY: 2.4 }).activeIds).toEqual(['a']);

    const rested = [{ type: 'dragEnd', velocityY: 2.4 } as const, { type: 'momentumBegin' } as const, { type: 'momentumEnd' } as const]
      .reduce(step, passing);
    expect(rested.activeIds).toEqual(['b']);
  });

  it('hands over in motion again once the phone is back on Wi-Fi', () => {
    const moving = [sawVideos([item('a')]), policy('wifi', 'cellular'), { type: 'dragBegin' } as const, policy('wifi', 'wifi')]
      .reduce(step, INITIAL_SHOWCASE_ACTIVATION_STATE);
    expect(step(moving, sawVideos([item('b')])).activeIds).toEqual(['b']);
  });

  it('on mobile data under Wi-Fi only, prepares nothing: no neighbour, and not the card being reached', () => {
    const resting = [policy('wifi', 'cellular'), sawVideos([item('b')])].reduce(step, INITIAL_SHOWCASE_ACTIVATION_STATE);
    expect(resting.activeIds).toEqual(['b']);
    expect(resting.preparedLimit).toBe(0);
    expect(selectPreparedActivationIds(resting, feed, { viewableIds: ['b'], anchorIds: ['b'], activeIds: ['b'] })).toEqual([]);
    expect(selectPreparedActivationIds(resting, feed, { viewableIds: ['c'], anchorIds: ['c'], activeIds: ['b'] })).toEqual([]);

    // The same feed on Wi-Fi keeps the neighbour on either side ready, as before.
    const onWifi = step(resting, policy('wifi', 'wifi'));
    expect(selectPreparedActivationIds(onWifi, feed, { viewableIds: ['b'], anchorIds: ['b'], activeIds: ['b'] })).toEqual(['c', 'a']);
  });

  it('prepares nothing and waits for rest under Never as well, where every tile shows its poster', () => {
    const state = step(INITIAL_SHOWCASE_ACTIVATION_STATE, policy('never', 'wifi'));
    expect(state).toMatchObject({ electOnlyAtRest: true, preparedLimit: 0 });
  });

  it('changes nobody\'s slot when the policy changes, and keeps the state for the same policy', () => {
    const playing = [sawVideos([item('a')]), { type: 'dragBegin' } as const].reduce(step, INITIAL_SHOWCASE_ACTIVATION_STATE);
    const saving = step(playing, policy('wifi', 'cellular'));
    expect(saving.activeIds).toBe(playing.activeIds);
    expect(saving.scroll).toBe('dragging');
    expect(step(saving, policy('wifi', 'cellular'))).toBe(saving);
  });

  it('keeps the policy through a reset, which clears only the list', () => {
    const saving = [sawVideos([item('a')]), policy('wifi', 'cellular')].reduce(step, INITIAL_SHOWCASE_ACTIVATION_STATE);
    const reset = step(saving, { type: 'reset' });
    expect(reset).toEqual({ ...INITIAL_SHOWCASE_ACTIVATION_STATE, electOnlyAtRest: true, preparedLimit: 0 });
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
