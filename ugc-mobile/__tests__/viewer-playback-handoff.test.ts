import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createViewerPlaybackHandoff } from '@/lib/viewer-playback-handoff';
import { resetViewerAudioMutedForTests, setViewerAudioMuted } from '@/lib/viewer-audio';

function fakePlayer() {
  return {
    muted: true,
    playing: false,
    play() { this.playing = true; },
    pause() { this.playing = false; },
  };
}
type Fake = ReturnType<typeof fakePlayer>;
const asPlayer = (fake: Fake) => fake as unknown as Parameters<ReturnType<typeof createViewerPlaybackHandoff>['register']>[1];

function setup() {
  const registry = createViewerPlaybackHandoff();
  const outgoing = fakePlayer();
  const incoming = fakePlayer();
  registry.register('a', asPlayer(outgoing));
  registry.register('b', asPlayer(incoming));
  registry.setAutoplayAllowed(true);
  outgoing.play();
  outgoing.muted = false;
  return { registry, outgoing, incoming };
}

describe('viewer playback handoff', () => {
  beforeEach(resetViewerAudioMutedForTests);
  afterEach(resetViewerAudioMutedForTests);

  it('stops the outgoing player and starts the landing player with the mute preference', () => {
    const { registry, outgoing, incoming } = setup();
    setViewerAudioMuted(true);
    registry.handoff({ from: 'a', to: 'b' });
    expect(outgoing).toMatchObject({ playing: false, muted: true });
    expect(incoming).toMatchObject({ playing: true, muted: true });
  });

  it('stops an early-started neighbour when focus or an overlay blocks playback', () => {
    const { registry, incoming } = setup();
    registry.handoff({ from: 'a', to: 'b' });
    expect(incoming).toMatchObject({ playing: true, muted: false });
    // React still considers b inactive: no active-prop transition is needed.
    registry.setAutoplayAllowed(false);
    expect(incoming).toMatchObject({ playing: false, muted: true });
    // A queued scroll event must not revive it after focus loss.
    registry.handoff({ from: 'b', to: 'b' });
    expect(incoming).toMatchObject({ playing: false, muted: true });
  });

  it('does not autoplay before focus is established or resume neighbours on focus return', () => {
    const registry = createViewerPlaybackHandoff();
    const incoming = fakePlayer();
    registry.register('b', asPlayer(incoming));
    registry.handoff({ to: 'b' });
    expect(incoming).toMatchObject({ playing: false, muted: true });
    registry.setAutoplayAllowed(true);
    expect(incoming.playing).toBe(false);
    registry.handoff({ to: 'b' });
    expect(incoming).toMatchObject({ playing: true, muted: false });
  });

  it('keeps the original viewer registration when a nested viewer of the same post closes', () => {
    const original = createViewerPlaybackHandoff();
    const nested = createViewerPlaybackHandoff();
    const first = fakePlayer();
    const second = fakePlayer();
    original.register('same-post', asPlayer(first));
    const unregister = nested.register('same-post', asPlayer(second));
    nested.setAutoplayAllowed(true);
    nested.handoff({ to: 'same-post' });
    expect(first.playing).toBe(false);
    expect(second.playing).toBe(true);
    nested.setAutoplayAllowed(false);
    unregister();
    original.setAutoplayAllowed(true);
    original.handoff({ to: 'same-post' });
    expect(first).toMatchObject({ playing: true, muted: false });
    expect(second).toMatchObject({ playing: false, muted: true });
  });

  it('does not stop another viewer when a hidden viewer receives a late event', () => {
    const hidden = setup();
    const visible = setup();
    hidden.registry.setAutoplayAllowed(false);
    visible.registry.handoff({ from: 'a', to: 'b' });
    hidden.registry.handoff({ from: 'a', to: 'b' });
    expect(visible.incoming).toMatchObject({ playing: true, muted: false });
    expect(hidden.incoming).toMatchObject({ playing: false, muted: true });
  });

  it('stops playback when the landing post has no video', () => {
    const { registry, outgoing } = setup();
    registry.handoff({ from: 'a', to: 'image' });
    expect(outgoing).toMatchObject({ playing: false, muted: true });
  });

  it('survives released players without preventing other players from stopping', () => {
    const { registry, incoming } = setup();
    const released = {
      set muted(_value: boolean) { throw new Error('released'); },
      play() { throw new Error('released'); },
      pause() { throw new Error('released'); },
    };
    registry.register('a', asPlayer(released as unknown as Fake));
    expect(() => registry.handoff({ from: 'a', to: 'b' })).not.toThrow();
    expect(incoming.playing).toBe(true);
    expect(() => registry.setAutoplayAllowed(false)).not.toThrow();
    expect(incoming.playing).toBe(false);
  });

  it('does not let an old registration cleanup remove its replacement', () => {
    const registry = createViewerPlaybackHandoff();
    const first = fakePlayer();
    const second = fakePlayer();
    const unregisterFirst = registry.register('a', asPlayer(first));
    registry.register('a', asPlayer(second));
    unregisterFirst();
    registry.setAutoplayAllowed(true);
    registry.handoff({ to: 'a' });
    expect(first.playing).toBe(false);
    expect(second.playing).toBe(true);
  });
});
