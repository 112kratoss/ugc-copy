import { afterEach, describe, expect, it, vi } from 'vitest';

import { START_POSTS_WAIT_MS, startPostsWithin } from '@/lib/creator-page-server';
import type { CreatorStartPost } from '@/lib/creator-start-posts';

vi.mock('@/components/RouteAuthBoundary', () => ({ requestHasAuthHint: async () => false }));

/**
 * How long a creator page waits for its start posts (the web sweep of 2026-11-17): handed over still on
 * their way, they came after the page's whole first part, drawn as empty places until then. The page
 * waits a moment past its other reads, then draws without them, so a slow or failing read never holds
 * the creator up for long.
 */
describe('startPostsWithin', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands over the posts once they are in, within the wait', async () => {
    const posts = [{ id: 'post-1' }] as unknown as CreatorStartPost[];
    await expect(startPostsWithin(Promise.resolve(posts))).resolves.toBe(posts);
  });

  it('takes posts that come in during the wait, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    let answer!: (posts: CreatorStartPost[]) => void;
    const posts = startPostsWithin(new Promise<CreatorStartPost[]>((resolve) => { answer = resolve; }));
    await vi.advanceTimersByTimeAsync(START_POSTS_WAIT_MS - 1);
    answer([]);
    await expect(posts).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers null for a read that fails, so the page hands it over and the canvas draws without it', async () => {
    await expect(startPostsWithin(Promise.reject(new Error('Connection closed.')))).resolves.toBeNull();
  });

  it('answers null once the wait is over, for the page to hand over the read itself', async () => {
    vi.useFakeTimers();
    let settled = false;
    const posts = startPostsWithin(new Promise<CreatorStartPost[]>(() => {}));
    void posts.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(START_POSTS_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(posts).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
