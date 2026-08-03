import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  parseProfileSharePayloadForRoute,
  shareCreatorProfileForRoute,
  type ProfileShareServiceDependencies,
} from '@/lib/profile-share-service';

const serviceClient = { service: true } as unknown as SupabaseClient;

/** Derived from the real dependency so it cannot drift from the row shape. */
type ShareableProfile = Awaited<
  ReturnType<ProfileShareServiceDependencies['findShareableProfileByUsername']>
>;

function createDependencies(
  profile: ShareableProfile = { id: 'creator-1', username: 'nova' },
) {
  return {
    findShareableProfileByUsername: vi.fn(async () => profile),
    isUserRelationshipBlocked: vi.fn(async () => false),
    recordProfileShareEvent: vi.fn(async () => undefined),
  } satisfies Partial<ProfileShareServiceDependencies>;
}

describe('parseProfileSharePayloadForRoute', () => {
  it('accepts a well-formed profile share', () => {
    const result = parseProfileSharePayloadForRoute({
      username: 'nova',
      sourceSurface: 'creator-profile',
      channel: 'copy-link',
    });

    expect(result).toEqual({
      ok: true,
      payload: { username: 'nova', sourceSurface: 'creator-profile', channel: 'copy-link' },
    });
  });

  it.each([
    [{ sourceSurface: 'creator-profile', channel: 'copy-link' }, 'Missing creator username'],
    [{ username: 'nova', sourceSurface: 'showcase', channel: 'copy-link' }, 'Invalid share source surface'],
    [{ username: 'nova', sourceSurface: 'creator-profile', channel: 'carrier-pigeon' }, 'Invalid share channel'],
  ])('rejects malformed payloads with a route-ready error', (body, expectedError) => {
    expect(parseProfileSharePayloadForRoute(body)).toEqual({
      ok: false,
      status: 400,
      body: { error: expectedError },
    });
  });

  it('refuses a post share surface, which belongs to the other ledger', () => {
    // 'creator-profile' is in both vocabularies; 'feed' is only in the post one.
    // Letting it through here would write a value the profile CHECK rejects.
    const result = parseProfileSharePayloadForRoute({
      username: 'nova',
      sourceSurface: 'feed',
      channel: 'native-share',
    });

    expect(result).toMatchObject({ ok: false, body: { error: 'Invalid share source surface' } });
  });
});

describe('shareCreatorProfileForRoute', () => {
  it('records the share against the profile it resolved', async () => {
    const dependencies = createDependencies();

    const result = await shareCreatorProfileForRoute({
      actorUserId: 'viewer-1',
      username: 'nova',
      sourceSurface: 'creator-profile',
      channel: 'native-share',
      dependencies,
      serviceClient,
    });

    expect(result).toEqual({ ok: true, body: { success: true } });
    expect(dependencies.recordProfileShareEvent).toHaveBeenCalledWith({
      profileUserId: 'creator-1',
      eventType: 'share_click',
      sourceSurface: 'creator-profile',
      channel: 'native-share',
      actorUserId: 'viewer-1',
    }, serviceClient);
  });

  it('records anonymous shares, which are most of the traffic on a public profile', async () => {
    const dependencies = createDependencies();

    const result = await shareCreatorProfileForRoute({
      actorUserId: null,
      username: 'nova',
      sourceSurface: 'creator-profile',
      channel: 'copy-link',
      dependencies,
      serviceClient,
    });

    expect(result.ok).toBe(true);
    expect(dependencies.recordProfileShareEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null }),
      serviceClient,
    );
    // No actor means no relationship to check.
    expect(dependencies.isUserRelationshipBlocked).not.toHaveBeenCalled();
  });

  it('reports an unknown username as not found rather than recording it', async () => {
    const dependencies = createDependencies(null);

    const result = await shareCreatorProfileForRoute({
      actorUserId: 'viewer-1',
      username: 'ghost',
      sourceSurface: 'creator-profile',
      channel: 'native-share',
      dependencies,
      serviceClient,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Only public creator profiles can be shared' },
    });
    expect(dependencies.recordProfileShareEvent).not.toHaveBeenCalled();
  });

  it('hides a blocked creator behind the same 404 as a missing one', async () => {
    const dependencies = createDependencies();
    dependencies.isUserRelationshipBlocked.mockResolvedValue(true);

    const result = await shareCreatorProfileForRoute({
      actorUserId: 'viewer-1',
      username: 'nova',
      sourceSurface: 'creator-profile',
      channel: 'native-share',
      dependencies,
      serviceClient,
    });

    expect(result.ok).toBe(false);
    expect(dependencies.recordProfileShareEvent).not.toHaveBeenCalled();
  });

  it('fails closed when the block check itself fails', async () => {
    // An unavailable moderation check must not be read as "not blocked" -- that
    // would let a blocked viewer's share through on a transient database error.
    const dependencies = createDependencies();
    dependencies.isUserRelationshipBlocked.mockRejectedValue(new Error('moderation unavailable'));

    const result = await shareCreatorProfileForRoute({
      actorUserId: 'viewer-1',
      username: 'nova',
      sourceSurface: 'creator-profile',
      channel: 'native-share',
      dependencies,
      serviceClient,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Only public creator profiles can be shared' },
    });
    expect(dependencies.recordProfileShareEvent).not.toHaveBeenCalled();
  });

  it('skips the block check when a creator shares their own profile', async () => {
    const dependencies = createDependencies();

    const result = await shareCreatorProfileForRoute({
      actorUserId: 'creator-1',
      username: 'nova',
      sourceSurface: 'profile',
      channel: 'copy-link',
      dependencies,
      serviceClient,
    });

    expect(result.ok).toBe(true);
    expect(dependencies.isUserRelationshipBlocked).not.toHaveBeenCalled();
  });
});
