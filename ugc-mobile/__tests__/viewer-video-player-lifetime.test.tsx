import React, { StrictMode } from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoPlayer } from 'expo-video';

const created = vi.hoisted(() => [] as { pause: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; audioMixingMode?: string }[]);
vi.mock('expo-video', () => ({
  createVideoPlayer: () => {
    const player = { pause: vi.fn(), release: vi.fn() };
    created.push(player);
    return player;
  },
}));

import { useViewerVideoPlayer } from '../lib/use-viewer-video-player.ios';
import { adoptVideoPlayer, claimReturnedVideoPlayer, handBackVideoPlayer, lendVideoPlayer, reclaimVideoPlayer, resetVideoPlayerLoans } from '../lib/video-player-loans';

let current: VideoPlayer;
function Viewer({ url }: { url: string }) {
  current = useViewerVideoPlayer(url, () => {});
  return null;
}

beforeEach(() => { vi.useFakeTimers(); created.length = 0; });
afterEach(() => { resetVideoPlayerLoans(); vi.useRealTimers(); });

describe('viewer video ownership', () => {
  it('creates once under Strict Mode and releases on a normal close', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<StrictMode><Viewer url="clip" /></StrictMode>); });
    expect(created).toHaveLength(1);
    act(() => { vi.runAllTimers(); });
    expect(created[0].release).not.toHaveBeenCalled();
    act(() => tree.unmount());
    act(() => { vi.runAllTimers(); });
    expect(created[0].release).toHaveBeenCalledTimes(1);
  });

  it('does not release the player a tile has taken', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<Viewer url="clip" />); });
    expect(handBackVideoPlayer(current, 'saved', 'clip')).toBe(true);
    expect(claimReturnedVideoPlayer('saved', 'clip')).toBe(current);
    act(() => tree.unmount());
    act(() => { vi.runAllTimers(); });
    expect(created[0].release).not.toHaveBeenCalled();
  });

  it('releases the reclaimed player after cancellation and a later normal close', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<Viewer url="clip" />); });
    handBackVideoPlayer(current, 'saved', 'clip');
    claimReturnedVideoPlayer('saved', 'clip');
    reclaimVideoPlayer(current);
    act(() => tree.unmount());
    act(() => { vi.runAllTimers(); });
    expect(created[0].release).toHaveBeenCalledTimes(1);
  });

  it('does not release a returned player reopened before the old cleanup timer', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<Viewer url="clip" />); });
    handBackVideoPlayer(current, 'saved', 'clip');
    claimReturnedVideoPlayer('saved', 'clip');
    act(() => tree.unmount());
    lendVideoPlayer(current, () => {});
    adoptVideoPlayer(current);
    act(() => { vi.advanceTimersByTime(200); });
    expect(created[0].release).not.toHaveBeenCalled();
  });

  it('releases the old source but keeps its replacement alive', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<Viewer url="one" />); });
    act(() => tree.update(<Viewer url="two" />));
    act(() => { vi.runAllTimers(); });
    expect(created[0].release).toHaveBeenCalledTimes(1);
    expect(created[1].release).not.toHaveBeenCalled();
    act(() => tree.unmount());
    act(() => { vi.runAllTimers(); });
    expect(created[1].release).toHaveBeenCalledTimes(1);
  });
});
