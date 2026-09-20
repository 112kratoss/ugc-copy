import { describe, expect, it, vi } from 'vitest';
import { decodeMediaLibraryCursor, encodeMediaLibraryCursor, mediaLibraryBoundaryFilter } from '@/lib/media-library-cursor';
import { listOwnerPostsForRoute } from '@/lib/owner-post-list-route-service';
const boundary = { id: '00000000-0000-0000-0000-000000000002', createdAt: '2026-09-20T12:00:00.123456+00:00' };
describe('media library cursor', () => {
  it('preserves microseconds and rejects another library/account scope', () => {
    const cursor = encodeMediaLibraryCursor('owner:u1:all:true', boundary);
    expect(decodeMediaLibraryCursor(cursor, 'owner:u1:all:true')).toEqual(boundary);
    expect(decodeMediaLibraryCursor(cursor, 'owner:u2:all:true')).toBeNull();
    expect(mediaLibraryBoundaryFilter(boundary, 'id')).toContain('id.lt.');
    expect(mediaLibraryBoundaryFilter(boundary, 'post_id', true)).toContain('post_id.gt.');
  });
  it('rejects malformed filters before reaching PostgREST', () => {
    for (const value of ['!', 'a'.repeat(2049), encodeMediaLibraryCursor('x', { ...boundary, id: 'x),id.gt.0' }), encodeMediaLibraryCursor('x', { ...boundary, createdAt: 'yesterday' })]) {
      expect(decodeMediaLibraryCursor(value, 'x')).toBeNull();
    }
  });
  it('continues at the last consumed row instead of a moving offset', async () => {
    const loadOwnerPosts = vi.fn(async () => [{ ...boundary }, { ...boundary, id: '00000000-0000-0000-0000-000000000003' }]);
    const first = await listOwnerPostsForRoute({ userId: 'u', searchParams: new URLSearchParams({ scope: 'owner', pagination: 'cursor', limit: '1' }), loadOwnerPosts });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.pageInfo.nextCursor).toBeTruthy();
    await listOwnerPostsForRoute({ userId: 'u', searchParams: new URLSearchParams({ scope: 'owner', cursor: first.pageInfo.nextCursor!, limit: '1' }), loadOwnerPosts });
    expect(loadOwnerPosts).toHaveBeenLastCalledWith('u', expect.objectContaining({ offset: 0, after: boundary }));
  });
});

it('rejects owner cursor reuse with different filters and mixed offset requests', async () => {
  const loadOwnerPosts = vi.fn(async () => []);
  const cursor = encodeMediaLibraryCursor('owner:u:all:false', boundary);
  for (const extra of [{ visibility: 'private' }, { offset: '24' }] as Array<Record<string, string>>) {
    const result = await listOwnerPostsForRoute({ userId: 'u', searchParams: new URLSearchParams({ scope: 'owner', cursor, ...extra }), loadOwnerPosts });
    expect(result).toMatchObject({ ok: false, status: 400 });
  }
  expect(loadOwnerPosts).not.toHaveBeenCalled();
});
