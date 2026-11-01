import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  getProfileForRoute,
  loadOwnerProfileTotals,
  updateProfileForRoute,
  type ProfileRouteClient,
  type ProfileRouteUser,
} from '@/lib/profile-route-service';
import type { UploadReservationRow } from '@/lib/upload-finalization';

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_url: string | null;
  website_url: string | null;
  twitter_handle: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  location: string | null;
  credits: number | null;
  promotional_credits?: number | null;
  saver_notice_seen_at?: string | null;
};

const user: ProfileRouteUser = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'creator@example.test',
  user_metadata: { full_name: 'Creator Metadata', avatar_url: 'https://example.test/avatar.png' },
};

// The RPC's jsonb since 2026-10-31: the Failed and Archived creations beside the Active ones.
const COUNTS = { creations: 6, failedCreations: 4, archivedCreations: 2, posts: 3, archivedPosts: 1, saved: 2 };
// The RPC's jsonb since 2026-10-17: paid sales and free unlocks apart.
const SALES = { earningsUsdCents: 1250, listingCount: 3, salesCount: 4, freeUnlockCount: 9 };

function createClient({
  profiles = [] as ProfileRow[],
  rateLimitAllowed = true,
  upsertError = null as { code?: string; message?: string } | null,
  upsertStatus = undefined as number | undefined,
  counts = COUNTS as unknown,
  countsError = null as { message: string } | null,
  sales = SALES as unknown,
  salesError = null as { message: string } | null,
} = {}) {
  const rows = [...profiles];
  const selectedColumns: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    if (name === 'owner_profile_counts') return { data: countsError ? null : counts, error: countsError };
    if (name === 'get_owner_post_sales_summary') return { data: salesError ? null : sales, error: salesError };
    return {
      data: {
        allowed: rateLimitAllowed,
        limit: 30,
        remaining: rateLimitAllowed ? 29 : 0,
        retryAfterSeconds: rateLimitAllowed ? 0 : 40,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    };
  });
  const upserts: Record<string, unknown>[] = [];

  const from = vi.fn((table: string) => {
    if (table !== 'profiles') {
      throw new Error(`Unexpected table: ${table}`);
    }

    const filters: Record<string, unknown> = {};
    let excludedId: string | null = null;
    const query = {
      select(columns?: string) {
        if (columns) selectedColumns.push(columns);
        return query;
      },
      eq(column: string, value: unknown) {
        filters[column] = value;
        return query;
      },
      neq(column: string, value: unknown) {
        if (column === 'id') {
          excludedId = String(value);
        }
        return query;
      },
      async maybeSingle() {
        const match = rows.find((profile) =>
          Object.entries(filters).every(([key, value]) => (profile as Record<string, unknown>)[key] === value) &&
          (!excludedId || profile.id !== excludedId)
        ) ?? null;

        return { data: match, error: null };
      },
      upsert(values: Record<string, unknown>) {
        upserts.push(values);
        return {
          select() {
            return {
              async single() {
                if (upsertError) {
                  return { data: null, error: upsertError, status: upsertStatus };
                }

                const profileId = values.id as string;
                const index = rows.findIndex((profile) => profile.id === profileId);
                // PostgREST's merge upsert: an existing row changes only in the
                // columns the body carries; a new row starts from the defaults.
                const nextProfile = {
                  ...(index === -1 ? emptyProfileRow(profileId) : rows[index]),
                  ...values,
                } as ProfileRow;

                if (index === -1) {
                  rows.push(nextProfile);
                } else {
                  rows[index] = nextProfile;
                }

                return { data: nextProfile, error: null };
              },
            };
          },
        };
      },
    };

    return query;
  });

  return {
    client: { rpc, from } as unknown as ProfileRouteClient,
    rpc,
    from,
    rows,
    selectedColumns,
    upserts,
  };
}

const PUBLIC_PROFILES = 'https://project.supabase.co/storage/v1/object/public/profiles/';

type StoredObject = { body: Buffer; contentType: string; id: string; version: string };

/** A profile photo the client signed, uploaded and finalized, as the upload state machine records it. */
function finalizedProfileUpload(role: 'avatar' | 'cover', uploadId: string, body: Buffer) {
  const storagePath = `${user.id}/${role}-${uploadId}-photo.png`;
  const reservation: UploadReservationRow = {
    id: uploadId,
    user_id: user.id,
    bucket_id: 'profiles',
    storage_path: storagePath,
    declared_bytes: body.byteLength,
    reserved_bytes: 5 * 1024 * 1024,
    expected_content_type: 'image/png',
    actual_bytes: body.byteLength,
    actual_content_type: 'image/png',
    actual_storage_id: `object-${uploadId}`,
    actual_storage_version: `version-${uploadId}`,
    finalization_status: 'finalized',
    issued_at: '2026-10-14T09:00:00.000Z',
    finalized_at: '2026-10-14T09:01:00.000Z',
    client_finalized_at: '2026-10-14T09:01:00.000Z',
    expires_at: '2026-10-14T11:00:00.000Z',
    released_at: null,
    consumed_at: null,
    consumption_disposition: null,
    consumption_lease_id: null,
    consumption_lease_expires_at: null,
    consumption_outcome_unknown_at: null,
    legacy_compatibility_mode: false,
    status_updated_at: '2026-10-14T09:01:00.000Z',
    reclaim_not_before: null,
    reclaim_after: null,
  };
  return { url: PUBLIC_PROFILES + storagePath, storagePath, body, reservation };
}

async function solidPng(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: '#336699' } }).png().toBuffer();
}

/**
 * The profile client plus what a save with photos touches: the reservation
 * table the real finalizer reads and moves, the lease RPCs as the database
 * applies them, and Storage.
 */
function createMediaClient({
  uploads,
  uploadError = null as { message: string } | null,
  ...options
}: Parameters<typeof createClient>[0] & {
  uploads: Array<ReturnType<typeof finalizedProfileUpload>>;
  uploadError?: { message: string } | null;
}) {
  const base = createClient(options);
  const reservations = uploads.map((upload) => ({ ...upload.reservation }));
  const objects = new Map<string, StoredObject>(uploads.map((upload) => [upload.storagePath, {
    body: upload.body,
    contentType: 'image/png',
    id: upload.reservation.actual_storage_id as string,
    version: upload.reservation.actual_storage_version as string,
  }]));

  const reservationQuery = () => {
    const filters: Array<[string, unknown]> = [];
    let changes: Partial<UploadReservationRow> | null = null;
    const query = {
      select: () => query,
      update: (values: Partial<UploadReservationRow>) => {
        changes = values;
        return query;
      },
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      },
      is: (column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      },
      async maybeSingle() {
        const row = reservations.find((candidate) => filters.every(([column, value]) => (
          (candidate as Record<string, unknown>)[column] === value
        )));
        if (row && changes) Object.assign(row, changes);
        return { data: row ? { ...row } : null, error: null };
      },
    };
    return query;
  };

  const rpc = vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
    const row = reservations.find((candidate) => (
      candidate.id === args.p_upload_id && candidate.user_id === args.p_user_id
    ));
    if (name === 'claim_upload_byte_reservation_consumption') {
      if (!row || !['finalized', 'consumed'].includes(row.finalization_status) || row.consumption_lease_id) {
        return { data: false, error: null };
      }
      Object.assign(row, {
        finalization_status: 'consuming',
        consumption_disposition: args.p_disposition,
        consumption_lease_id: args.p_lease_id,
        consumption_lease_expires_at: '2026-10-14T09:31:00.000Z',
      });
      return { data: true, error: null };
    }
    if (name === 'complete_upload_byte_reservation_consumption') {
      if (
        !row
        || row.finalization_status !== 'consuming'
        || row.consumption_lease_id !== args.p_lease_id
        || row.consumption_disposition !== args.p_disposition
      ) return { data: false, error: null };
      Object.assign(row, {
        finalization_status: 'consumed',
        consumed_at: '2026-10-14T09:02:00.000Z',
        consumption_lease_id: null,
        consumption_lease_expires_at: null,
      });
      return { data: true, error: null };
    }
    if (name === 'abort_upload_byte_reservation_consumption') {
      if (!row || row.finalization_status !== 'consuming' || row.consumption_lease_id !== args.p_lease_id) {
        return { data: false, error: null };
      }
      Object.assign(row, {
        finalization_status: row.consumed_at === null ? 'finalized' : 'consumed',
        consumption_disposition: row.consumed_at === null ? null : row.consumption_disposition,
        consumption_lease_id: null,
        consumption_lease_expires_at: null,
      });
      return { data: true, error: null };
    }
    return base.rpc(name);
  });

  const missing = { message: 'Object not found', statusCode: '404' };
  const storageApi = {
    info: vi.fn(async (path: string) => {
      const object = objects.get(path);
      return object
        ? {
            data: {
              id: object.id,
              version: object.version,
              bucketId: 'profiles',
              contentType: object.contentType,
              size: object.body.byteLength,
            },
            error: null,
          }
        : { data: null, error: missing };
    }),
    download: vi.fn(async (path: string) => {
      const object = objects.get(path);
      return object
        ? { data: new Blob([new Uint8Array(object.body)], { type: object.contentType }), error: null }
        : { data: null, error: missing };
    }),
    upload: vi.fn(async (path: string, body: Blob, uploadOptions: { contentType?: string } = {}) => {
      if (uploadError) return { data: null, error: uploadError };
      objects.set(path, {
        body: Buffer.from(await body.arrayBuffer()),
        contentType: uploadOptions.contentType ?? 'application/octet-stream',
        id: `object-${path}`,
        version: 'version-1',
      });
      return { data: { path }, error: null };
    }),
    remove: vi.fn(async (paths: string[]) => {
      for (const path of paths) objects.delete(path);
      return { data: paths.map((name) => ({ name })), error: null };
    }),
  };

  return {
    ...base,
    client: {
      rpc,
      from: (table: string) => (table === 'upload_byte_reservations' ? reservationQuery() : base.from(table)),
      storage: { from: vi.fn(() => storageApi) },
    } as unknown as ProfileRouteClient,
    rpc,
    reservations,
    objects,
    storageApi,
  };
}

const AVATAR_UPLOAD_ID = '22222222-2222-4222-8222-222222222222';
const COVER_UPLOAD_ID = '33333333-3333-4333-8333-333333333333';

function emptyProfileRow(id: string): ProfileRow {
  return {
    id,
    username: null,
    display_name: null,
    bio: null,
    avatar_url: null,
    cover_url: null,
    website_url: null,
    twitter_handle: null,
    instagram_handle: null,
    tiktok_handle: null,
    location: null,
    credits: null,
  };
}

function storedProfile(): ProfileRow {
  return {
    id: user.id,
    username: 'luna',
    display_name: 'Luna Dreams',
    bio: null,
    avatar_url: null,
    cover_url: null,
    website_url: null,
    twitter_handle: null,
    instagram_handle: null,
    tiktok_handle: null,
    location: null,
    credits: 12,
  };
}

describe('profile route service', () => {
  it('returns a starter profile payload when no profile row exists', async () => {
    const client = createClient();

    await expect(getProfileForRoute({ user, client: client.client })).resolves.toEqual({
      ok: true,
      response: {
        id: user.id,
        username: null,
        suggestedUsername: 'creator-11111111',
        displayName: 'Creator Metadata',
        bio: null,
        avatarUrl: 'https://example.test/avatar.png',
        coverUrl: null,
        websiteUrl: null,
        twitterHandle: null,
        instagramHandle: null,
        tiktokHandle: null,
        location: null,
        credits: null,
        // An account with no row has been told nothing.
        saverNoticeSeen: false,
        stats: COUNTS,
        sales: SALES,
      },
    });
  });

  // The app and the web start the saver notice from this, so neither has to
  // ask for the record on its own.
  it('says whether the account has been told that creators can see who saved, from the row it reads', async () => {
    const client = createClient({ profiles: [{ ...storedProfile(), saver_notice_seen_at: '2026-10-19T09:00:00.000Z' }] });

    await expect(getProfileForRoute({ user, client: client.client })).resolves.toMatchObject({
      ok: true,
      response: { username: 'luna', saverNoticeSeen: true },
    });
    expect(client.selectedColumns[0]?.split(',').map((column) => column.trim())).toContain('saver_notice_seen_at');

    for (const seenAt of [null, undefined]) {
      client.rows[0] = { ...client.rows[0], saver_notice_seen_at: seenAt };
      const result = await getProfileForRoute({ user, client: client.client });
      expect(result).toMatchObject({ ok: true, response: { saverNoticeSeen: false } });
    }
  });

  it('says the library totals and the seller summary beside a stored profile, from the service-role RPCs', async () => {
    const client = createClient({ profiles: [storedProfile()] });

    const result = await getProfileForRoute({ user, client: client.client });

    expect(result).toMatchObject({
      ok: true,
      response: { id: user.id, username: 'luna', credits: 12, stats: COUNTS, sales: SALES },
    });
    expect(client.rpc).toHaveBeenCalledWith('owner_profile_counts', { p_user_id: user.id });
    expect(client.rpc).toHaveBeenCalledWith('get_owner_post_sales_summary', { p_owner_id: user.id });
  });

  // The app reads its recipe balance from here: welcome and referral credits
  // are in the total but cannot buy a recipe.
  it('says how much of the balance can buy a recipe, from the promotional credits it reads', async () => {
    const client = createClient({ profiles: [{ ...storedProfile(), credits: 1200, promotional_credits: 1200 }] });

    const result = await getProfileForRoute({ user, client: client.client });

    expect(result).toMatchObject({
      ok: true,
      response: { credits: 1200, promotionalCredits: 1200, marketplaceSpendableCredits: 0 },
    });
    expect(client.selectedColumns[0]?.split(',').map((column) => column.trim())).toEqual(
      expect.arrayContaining(['credits', 'promotional_credits']),
    );

    client.rows[0] = { ...client.rows[0], credits: 1500, promotional_credits: 300 };
    await expect(getProfileForRoute({ user, client: client.client })).resolves.toMatchObject({
      response: { credits: 1500, promotionalCredits: 300, marketplaceSpendableCredits: 1200 },
    });
  });

  it('leaves a total out when its read fails, and still returns the profile', async () => {
    const client = createClient({ profiles: [storedProfile()], countsError: { message: 'count timed out' } });

    const result = await getProfileForRoute({ user, client: client.client });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.username).toBe('luna');
    expect(result.response).not.toHaveProperty('stats');
    expect(result.response.sales).toEqual(SALES);
  });

  it('keeps every total a whole, non-negative number whatever the database sends', async () => {
    const client = createClient({
      profiles: [storedProfile()],
      counts: { creations: '7', failedCreations: '3', archivedCreations: -1, posts: -2, archivedPosts: 1.6, saved: null },
      sales: { earningsUsdCents: '90', listingCount: undefined },
    });

    const result = await getProfileForRoute({ user, client: client.client });

    expect(result).toMatchObject({
      ok: true,
      response: {
        stats: { creations: 7, failedCreations: 3, archivedCreations: 0, posts: 0, archivedPosts: 2, saved: 0 },
        sales: { earningsUsdCents: 90, listingCount: 0, salesCount: 0, freeUnlockCount: 0 },
      },
    });
  });

  it('leaves the creation scope totals out while the database does not count them', async () => {
    // The function as it was before 20261031231029: a 0 here would read as
    // "no failed runs" and hide the app's Failed chip.
    const client = createClient({
      profiles: [storedProfile()],
      counts: { creations: 6, posts: 3, archivedPosts: 1, saved: 2 },
    });

    const result = await getProfileForRoute({ user, client: client.client });

    expect(result.ok).toBe(true);
    const stats = result.ok ? (result.response as { stats?: Record<string, unknown> }).stats : undefined;
    expect(stats).toEqual({ creations: 6, posts: 3, archivedPosts: 1, saved: 2 });
    expect(stats).not.toHaveProperty('failedCreations');
    expect(stats).not.toHaveProperty('archivedCreations');
  });

  it('rate limits profile updates before validation and persistence', async () => {
    const client = createClient({ rateLimitAllowed: false });

    const result = await updateProfileForRoute({
      userId: user.id,
      body: {
        username: 'taken-name',
        displayName: 'Creator Name',
      },
      client: client.client,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 40,
    });
    expect(client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'profile:update',
      p_subject_key: user.id,
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(client.from).not.toHaveBeenCalled();
    expect(client.upserts).toHaveLength(0);
  });

  it('validates, normalizes, and upserts profile updates', async () => {
    const client = createClient({
      profiles: [{
        id: user.id,
        username: null,
        display_name: 'Existing',
        bio: null,
        avatar_url: null,
        cover_url: null,
        website_url: null,
        twitter_handle: null,
        instagram_handle: null,
        tiktok_handle: null,
        location: null,
        credits: 25,
      }],
    });
    const invalidateFeedCache = vi.fn();

    const result = await updateProfileForRoute({
      userId: user.id,
      body: {
        username: 'Creator-Name',
        displayName: 'Creator Name',
        bio: 'UGC creator for product demos.',
      },
      client: client.client,
      invalidateFeedCache,
    });

    expect(client.upserts[0]).toMatchObject({
      id: user.id,
      username: 'creator-name',
      display_name: 'Creator Name',
      bio: 'UGC creator for product demos.',
    });
    expect(result).toMatchObject({
      ok: true,
      response: {
        id: user.id,
        username: 'creator-name',
        suggestedUsername: 'creator-11111111',
        displayName: 'Creator Name',
        credits: 25,
      },
    });
    expect(invalidateFeedCache).toHaveBeenCalledOnce();
  });

  // The app reads a 409 as the handle's only when it names the field: the
  // proxy's SESSION_MERGED and ACCOUNT_DELETING 409s name none.
  const usernameTaken = mobileApiContract.profileUsernameTaken;

  it('returns stable username conflict errors from profile upserts', async () => {
    const client = createClient({
      upsertError: { code: '23505', message: 'duplicate key' },
    });
    const invalidateFeedCache = vi.fn();

    await expect(updateProfileForRoute({
      userId: user.id,
      body: {
        username: 'creator-name',
        displayName: 'Creator Name',
      },
      client: client.client,
      invalidateFeedCache,
    })).resolves.toEqual({
      ok: false,
      status: usernameTaken.status,
      error: usernameTaken.response.error,
      fieldErrors: usernameTaken.response.fieldErrors,
    });
    expect(invalidateFeedCache).not.toHaveBeenCalled();
  });

  it('names the field when another profile already holds the handle', async () => {
    const client = createClient({
      profiles: [storedProfile(), { ...emptyProfileRow('22222222-2222-2222-2222-222222222222'), username: 'creator-name' }],
    });
    const invalidateFeedCache = vi.fn();

    await expect(updateProfileForRoute({
      userId: user.id,
      body: {
        username: 'creator-name',
        displayName: 'Creator Name',
      },
      client: client.client,
      invalidateFeedCache,
    })).resolves.toEqual({
      ok: false,
      status: usernameTaken.status,
      error: usernameTaken.response.error,
      fieldErrors: usernameTaken.response.fieldErrors,
    });
    expect(client.upserts).toEqual([]);
    expect(invalidateFeedCache).not.toHaveBeenCalled();
  });

  it('writes only the fields a save carries, so a bio edit keeps the stored links', async () => {
    const client = createClient({
      profiles: [{
        ...storedProfile(),
        website_url: 'https://luna.example',
        instagram_handle: 'luna.dreams',
        location: 'Bengaluru',
      }],
    });

    const result = await updateProfileForRoute({
      userId: user.id,
      body: { username: 'luna', bio: 'Painting with light.' },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    });

    // Absent keys never reach the write, so the database keeps those columns.
    expect(client.upserts).toEqual([{ id: user.id, username: 'luna', bio: 'Painting with light.' }]);
    expect(result).toMatchObject({
      ok: true,
      response: {
        displayName: 'Luna Dreams',
        bio: 'Painting with light.',
        websiteUrl: 'https://luna.example',
        instagramHandle: 'luna.dreams',
        location: 'Bengaluru',
      },
    });
  });

  it('clears a field the save sends as null and keeps the rest', async () => {
    const client = createClient({
      profiles: [{ ...storedProfile(), website_url: 'https://luna.example', location: 'Bengaluru' }],
    });

    const result = await updateProfileForRoute({
      userId: user.id,
      body: { username: 'luna', websiteUrl: null },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    });

    expect(client.upserts).toEqual([{ id: user.id, username: 'luna', website_url: null }]);
    expect(result).toMatchObject({ ok: true, response: { websiteUrl: null, location: 'Bengaluru' } });
    expect(client.rows[0]).toMatchObject({ website_url: null, location: 'Bengaluru', display_name: 'Luna Dreams' });
  });

  it('still saves the full ten-field body the web sends, normalising the links', async () => {
    const client = createClient({
      profiles: [{ ...storedProfile(), website_url: 'https://old.example', twitter_handle: 'old_handle' }],
    });

    const result = await updateProfileForRoute({
      userId: user.id,
      body: {
        username: 'luna',
        displayName: 'Luna Dreams',
        bio: 'Painting with light.',
        avatarUrl: '',
        coverUrl: '',
        websiteUrl: 'https://luna.example',
        twitterHandle: '@luna_dreams',
        instagramHandle: 'https://www.instagram.com/luna.dreams/',
        tiktokHandle: '',
        location: ' Bengaluru ',
      },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    });

    expect(client.upserts).toEqual([{
      id: user.id,
      username: 'luna',
      display_name: 'Luna Dreams',
      bio: 'Painting with light.',
      avatar_url: null,
      cover_url: null,
      website_url: 'https://luna.example',
      twitter_handle: 'luna_dreams',
      instagram_handle: 'luna.dreams',
      tiktok_handle: null,
      location: 'Bengaluru',
    }]);
    expect(result).toMatchObject({
      ok: true,
      response: {
        websiteUrl: 'https://luna.example',
        twitterHandle: 'luna_dreams',
        instagramHandle: 'luna.dreams',
        tiktokHandle: null,
        location: 'Bengaluru',
        credits: 12,
      },
    });
  });

  it('refuses a social link to another site with a field error and writes nothing', async () => {
    const client = createClient({ profiles: [storedProfile()] });

    await expect(updateProfileForRoute({
      userId: user.id,
      body: { username: 'luna', instagramHandle: 'https://evil.example/luna' },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    })).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'Please fix the highlighted fields.',
      fieldErrors: { instagramHandle: 'Enter your Instagram username or profile link.' },
    });
    expect(client.upserts).toHaveLength(0);
  });

  it('refuses a newly claimed reserved handle before any write', async () => {
    const client = createClient({ profiles: [storedProfile()] });
    const invalidateFeedCache = vi.fn();

    await expect(updateProfileForRoute({
      userId: user.id,
      body: { username: 'Support', displayName: 'Luna Dreams' },
      client: client.client,
      invalidateFeedCache,
    })).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'That handle is reserved.',
      fieldErrors: { username: 'That handle is reserved.' },
    });
    expect(client.upserts).toHaveLength(0);
    expect(invalidateFeedCache).not.toHaveBeenCalled();
  });

  it('lets an account that already holds a reserved handle keep it through an unrelated edit', async () => {
    const client = createClient({ profiles: [{ ...storedProfile(), username: 'support' }] });

    const result = await updateProfileForRoute({
      userId: user.id,
      body: { username: 'support', bio: 'Answers within a day.' },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    });

    expect(result).toMatchObject({ ok: true, response: { username: 'support', bio: 'Answers within a day.' } });
  });

  it('points the profile at a normalised copy of each new photo and releases the uploads to the reclaim job', async () => {
    const avatar = finalizedProfileUpload('avatar', AVATAR_UPLOAD_ID, await solidPng(1024, 1024));
    const cover = finalizedProfileUpload('cover', COVER_UPLOAD_ID, await solidPng(1200, 1200));
    const client = createMediaClient({ profiles: [storedProfile()], uploads: [avatar, cover] });

    const result = await updateProfileForRoute({
      userId: user.id,
      body: { username: 'luna', avatarUrl: avatar.url, coverUrl: cover.url },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    });

    const avatarCopy = new RegExp(`^${PUBLIC_PROFILES}${user.id}/avatar-${AVATAR_UPLOAD_ID}-photo\\.normalized\\.[0-9a-f]{16}\\.webp$`);
    const coverCopy = new RegExp(`^${PUBLIC_PROFILES}${user.id}/cover-${COVER_UPLOAD_ID}-photo\\.normalized\\.[0-9a-f]{16}\\.webp$`);
    expect(client.upserts).toHaveLength(1);
    expect(client.upserts[0].avatar_url).toMatch(avatarCopy);
    expect(client.upserts[0].cover_url).toMatch(coverCopy);
    expect(result).toMatchObject({
      ok: true,
      response: { avatarUrl: client.upserts[0].avatar_url, coverUrl: client.upserts[0].cover_url },
    });

    // The copies are what the profile shows; the uploads stay byte for byte.
    const avatarCopyPath = String(client.upserts[0].avatar_url).slice(PUBLIC_PROFILES.length);
    const coverCopyPath = String(client.upserts[0].cover_url).slice(PUBLIC_PROFILES.length);
    const avatarMetadata = await sharp(client.objects.get(avatarCopyPath)!.body).metadata();
    const coverMetadata = await sharp(client.objects.get(coverCopyPath)!.body).metadata();
    expect([avatarMetadata.width, avatarMetadata.height]).toEqual([512, 512]);
    expect([coverMetadata.width, coverMetadata.height]).toEqual([1200, 270]);
    expect(client.objects.get(avatar.storagePath)?.body.equals(avatar.body)).toBe(true);
    expect(client.objects.get(cover.storagePath)?.body.equals(cover.body)).toBe(true);
    expect(client.storageApi.upload.mock.calls.map(([path]) => path)).toEqual([avatarCopyPath, coverCopyPath]);

    // Each upload was leased for the read, then released rather than kept:
    // nothing references it, so the reclaim job deletes it.
    const leaseRpcs = client.rpc.mock.calls
      .filter(([name]) => String(name).endsWith('_upload_byte_reservation_consumption'))
      .map(([name, args]) => [name, (args as Record<string, unknown>).p_upload_id]);
    expect(leaseRpcs).toEqual([
      ['claim_upload_byte_reservation_consumption', AVATAR_UPLOAD_ID],
      ['claim_upload_byte_reservation_consumption', COVER_UPLOAD_ID],
      ['abort_upload_byte_reservation_consumption', AVATAR_UPLOAD_ID],
      ['abort_upload_byte_reservation_consumption', COVER_UPLOAD_ID],
    ]);
    expect(client.reservations.map((row) => [row.finalization_status, row.consumption_disposition])).toEqual([
      ['finalized', null],
      ['finalized', null],
    ]);
  });

  it('keeps a photo that is already right as it is, and holds its upload for good', async () => {
    const avatar = finalizedProfileUpload('avatar', AVATAR_UPLOAD_ID, await solidPng(256, 256));
    const client = createMediaClient({ profiles: [storedProfile()], uploads: [avatar] });

    const result = await updateProfileForRoute({
      userId: user.id,
      body: { username: 'luna', avatarUrl: avatar.url },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    });

    expect(result).toMatchObject({ ok: true, response: { avatarUrl: avatar.url } });
    expect(client.upserts[0].avatar_url).toBe(avatar.url);
    expect(client.storageApi.upload).not.toHaveBeenCalled();
    expect(client.reservations[0]).toMatchObject({
      finalization_status: 'consumed',
      consumption_disposition: 'preserve',
    });
  });

  it('saves the upload itself when its copy cannot be written', async () => {
    const avatar = finalizedProfileUpload('avatar', AVATAR_UPLOAD_ID, await solidPng(1024, 1024));
    const client = createMediaClient({
      profiles: [storedProfile()],
      uploads: [avatar],
      uploadError: { message: 'Upload owner has been permanently blocked' },
    });

    const result = await updateProfileForRoute({
      userId: user.id,
      body: { username: 'luna', avatarUrl: avatar.url },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    });

    expect(result).toMatchObject({ ok: true, response: { avatarUrl: avatar.url } });
    expect(client.reservations[0]).toMatchObject({
      finalization_status: 'consumed',
      consumption_disposition: 'preserve',
    });
  });

  it('takes back the copy\'s own URL on a later save without copying it again', async () => {
    const avatar = finalizedProfileUpload('avatar', AVATAR_UPLOAD_ID, await solidPng(1024, 1024));
    const client = createMediaClient({ profiles: [storedProfile()], uploads: [avatar] });
    await updateProfileForRoute({
      userId: user.id,
      body: { username: 'luna', avatarUrl: avatar.url },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    });
    const copyUrl = String(client.upserts[0].avatar_url);
    client.storageApi.download.mockClear();
    client.storageApi.upload.mockClear();

    // The web sends every field back on every save, the photo URL included.
    const result = await updateProfileForRoute({
      userId: user.id,
      body: { username: 'luna', bio: 'Painting with light.', avatarUrl: copyUrl },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    });

    expect(result).toMatchObject({ ok: true, response: { avatarUrl: copyUrl, bio: 'Painting with light.' } });
    expect(client.upserts[1].avatar_url).toBe(copyUrl);
    expect(client.storageApi.download).not.toHaveBeenCalled();
    expect(client.storageApi.upload).not.toHaveBeenCalled();
  });

  it('a save the database refuses after the copy releases the upload and leaves the copy alone', async () => {
    const avatar = finalizedProfileUpload('avatar', AVATAR_UPLOAD_ID, await solidPng(1024, 1024));
    const client = createMediaClient({
      profiles: [storedProfile()],
      uploads: [avatar],
      upsertError: { code: '23505', message: 'duplicate key' },
      upsertStatus: 409,
    });

    await expect(updateProfileForRoute({
      userId: user.id,
      body: { username: 'luna', avatarUrl: avatar.url },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    })).resolves.toMatchObject({ ok: false, status: 409 });

    expect(client.reservations[0]).toMatchObject({ finalization_status: 'finalized', consumption_disposition: null });
    expect(client.rpc).not.toHaveBeenCalledWith('complete_upload_byte_reservation_consumption', expect.anything());
    // Content-addressed: an earlier save of the same upload may point at it.
    expect(client.storageApi.remove).not.toHaveBeenCalled();
    expect([...client.objects.keys()].some((path) => path.includes('.normalized.'))).toBe(true);
  });

  it('exports the totals loader the web profile page reads', async () => {
    const client = createClient();

    await expect(loadOwnerProfileTotals(client.client, user.id)).resolves.toEqual({ stats: COUNTS, sales: SALES });
    expect(client.from).not.toHaveBeenCalled();
  });
});
