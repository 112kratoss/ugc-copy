import { describe, expect, it } from 'vitest';

import { isOwnerPostLibraryMember, ownerPostToProfileMediaCard } from '../lib/profile-view-model';
import type { OwnerPostListItem } from '../lib/types';

function post(overrides: Partial<OwnerPostListItem> = {}): OwnerPostListItem {
  return {
    id: 'post-1',
    title: 'Launch post',
    createdAt: '2026-09-02T10:00:00.000Z',
    visibility: 'public',
    mediaUrl: 'https://cdn.example.com/post.png',
    mediaKind: 'image',
    commentCount: 0,
    category: 'image',
    postFormat: 'media',
    bundle: null,
    ...overrides,
  } as OwnerPostListItem;
}

describe('owner post library membership', () => {
  it('places a post in exactly the scope its grid tile is drawn in', () => {
    const active = post();
    const archived = post({ id: 'post-2', archivedAt: '2026-09-10T00:00:00.000Z' });

    expect(isOwnerPostLibraryMember(active, 'active')).toBe(true);
    expect(isOwnerPostLibraryMember(active, 'archived')).toBe(false);
    expect(isOwnerPostLibraryMember(archived, 'archived')).toBe(true);
    expect(isOwnerPostLibraryMember(archived, 'active')).toBe(false);
  });

  it('leaves out a post the grid cannot draw a tile for', () => {
    const posterless = post({ mediaUrl: 'https://cdn.example.com/clip.mp4', mediaKind: 'video', category: 'video' });

    expect(ownerPostToProfileMediaCard(posterless).isGridReady).toBe(false);
    expect(isOwnerPostLibraryMember(posterless, 'active')).toBe(false);
  });
});
