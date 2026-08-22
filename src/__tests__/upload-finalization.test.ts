import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  deleteReservedObjectAndConfirm,
  finalizeUploadForConsumption,
  finalizeUploadRequest,
  reclaimExpiredUploadReservations,
  type UploadReservationRow,
} from '@/lib/upload-finalization';

const UPLOAD_ID = '11111111-1111-4111-8111-111111111111';

function reservation(overrides: Partial<UploadReservationRow> = {}): UploadReservationRow {
  return {
    id: UPLOAD_ID,
    user_id: 'user-1',
    bucket_id: 'uploads',
    storage_path: 'user-1/reference.png',
    declared_bytes: 1,
    reserved_bytes: 25 * 1024 * 1024,
    expected_content_type: 'image/png',
    actual_bytes: null,
    actual_content_type: null,
    actual_storage_id: null,
    actual_storage_version: null,
    finalization_status: 'issued',
    issued_at: '2026-08-19T09:00:00.000Z',
    finalized_at: null,
    client_finalized_at: null,
    expires_at: '2026-08-19T12:00:00.000Z',
    released_at: null,
    consumed_at: null,
    consumption_disposition: null,
    consumption_lease_id: null,
    consumption_lease_expires_at: null,
    consumption_outcome_unknown_at: null,
    legacy_compatibility_mode: false,
    status_updated_at: '2026-08-19T09:00:00.000Z',
    reclaim_not_before: null,
    reclaim_after: null,
    ...overrides,
  } as UploadReservationRow;
}

function createClient({
  row = reservation(),
  info = {
    id: 'storage-object-1',
    version: 'storage-version-1',
    bucketId: 'uploads',
    contentType: 'image/png',
    size: 1,
  },
  infoError = null as unknown,
  intentRows = [] as Array<{
    user_id: string;
    storage_path: string;
    storage_cleared_at: string | null;
  }>,
  removeData,
  removeError = null as unknown,
}: {
  row?: UploadReservationRow | null;
  info?: Record<string, unknown>;
  infoError?: unknown;
  intentRows?: Array<{
    user_id: string;
    storage_path: string;
    storage_cleared_at: string | null;
  }>;
  removeData?: Array<{ name?: string }>;
  removeError?: unknown;
} = {}) {
  let current = row ? { ...row } : null;
  let currentInfo: Record<string, unknown> | null = info;
  let currentInfoError = infoError;
  const updates: Array<Record<string, unknown>> = [];
  const remove = vi.fn(async (paths: string[]) => ({
    data: removeError ? null : removeData ?? paths.map((name) => ({ name })),
    error: removeError,
  }));
  const storageInfo = vi.fn(async () => ({
    data: currentInfoError ? null : currentInfo,
    error: currentInfoError,
  }));
  const rpc = vi.fn(async () => ({ data: true, error: null }));

  const matchingRow = (filters: Array<[string, unknown]>) => current && filters.every(([column, value]) => {
    return (current as unknown as Record<string, unknown>)[column] === value;
  }) ? current : null;

  const from = vi.fn((table: string) => table === 'media_upload_intents' ? ({
    select: vi.fn(() => {
      const chain = {
        in: vi.fn(() => chain),
        then: (resolve: (value: { data: typeof intentRows; error: null }) => unknown) => (
          Promise.resolve(resolve({ data: intentRows, error: null }))
        ),
      };
      return chain;
    }),
  }) : ({
    select: vi.fn(() => {
      const filters: Array<[string, unknown]> = [];
      let allowedStatuses: string[] | null = null;
      const chain = {
        eq: vi.fn((column: string, value: unknown) => {
          filters.push([column, value]);
          return chain;
        }),
        maybeSingle: vi.fn(async () => ({ data: matchingRow(filters), error: null })),
        is: vi.fn((column: string, value: unknown) => {
          filters.push([column, value]);
          return chain;
        }),
        in: vi.fn((column: string, values: string[]) => {
          if (column === 'finalization_status') allowedStatuses = values;
          return chain;
        }),
        lte: vi.fn(() => chain),
        gt: vi.fn(() => chain),
        or: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (value: { data: UploadReservationRow[]; error: null }) => unknown) => (
          Promise.resolve(resolve({
            data: matchingRow(filters)
              && (!allowedStatuses || allowedStatuses.includes(current?.finalization_status ?? ''))
              ? [current as UploadReservationRow]
              : [],
            error: null,
          }))
        ),
      };
      return chain;
    }),
    update: vi.fn((values: Record<string, unknown>) => {
      const filters: Array<[string, unknown]> = [];
      let allowedStatuses: string[] | null = null;
      const execute = () => {
        const matched = matchingRow(filters)
          && (!allowedStatuses || allowedStatuses.includes(current?.finalization_status ?? ''));
        if (matched && current) {
          updates.push(values);
          current = { ...current, ...values } as UploadReservationRow;
        }
        return { data: matched ? current : null, error: null };
      };
      const chain = {
        eq: vi.fn((column: string, value: unknown) => {
          filters.push([column, value]);
          return chain;
        }),
        in: vi.fn((_column: string, values: string[]) => {
          allowedStatuses = values;
          return chain;
        }),
        is: vi.fn((column: string, value: unknown) => {
          filters.push([column, value]);
          return chain;
        }),
        lte: vi.fn(() => chain),
        select: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => execute()),
        then: (resolve: (value: { data: UploadReservationRow | null; error: null }) => unknown) => (
          Promise.resolve(resolve(execute()))
        ),
      };
      return chain;
    }),
  }));

  return {
    client: {
      from,
      rpc,
      storage: { from: vi.fn(() => ({ info: storageInfo, remove })) },
    } as unknown as SupabaseClient,
    get row() { return current; },
    remove,
    storageInfo,
    rpc,
    updates,
    from,
    setInfo(next: Record<string, unknown> | null, error: unknown = null) {
      currentInfo = next;
      currentInfoError = error;
    },
  };
}

describe('generic upload finalization', () => {
  it('uses trusted metadata and returns the canonical descriptor', async () => {
    const fake = createClient();

    await expect(finalizeUploadRequest(fake.client, {
      body: { uploadId: UPLOAD_ID },
      userId: 'user-1',
    })).resolves.toEqual({
      ok: true,
      canonicalPath: 'user-1/reference.png',
      reservationId: UPLOAD_ID,
      descriptor: {
        bucket: 'uploads',
        path: 'user-1/reference.png',
        storagePath: 'uploads/user-1/reference.png',
        contentType: 'image/png',
        sizeBytes: 1,
      },
    });

    expect(fake.row).toMatchObject({
      actual_bytes: 1,
      actual_content_type: 'image/png',
      finalization_status: 'finalized',
    });
    // Finalization reconciles the reservation to trusted actual bytes, but it
    // remains active until a durable consumer claims the object. Otherwise a
    // caller could finalize repeatedly and leak unreferenced objects without
    // retaining any aggregate admission charge.
    expect(fake.row?.released_at).toBeNull();
    expect(fake.remove).not.toHaveBeenCalled();
  });

  it('deletes a dishonest larger upload even though its worst-case bytes were reserved', async () => {
    const fake = createClient({
      info: {
        id: 'storage-object-1',
        version: 'storage-version-1',
        bucketId: 'uploads',
        contentType: 'image/png',
        size: 2,
      },
    });

    await expect(finalizeUploadRequest(fake.client, {
      body: { uploadId: UPLOAD_ID },
      userId: 'user-1',
    })).resolves.toMatchObject({
      ok: false,
      status: 400,
      code: 'UPLOAD_METADATA_MISMATCH',
    });

    expect(fake.remove).toHaveBeenCalledWith(['user-1/reference.png']);
    expect(fake.row).toMatchObject({
      actual_bytes: 2,
      finalization_status: 'deleted',
    });
    expect(fake.row?.released_at).toBeNull();
  });

  it('accepts only uploadId and never trusts client-supplied path or metadata', async () => {
    const fake = createClient();

    await expect(finalizeUploadRequest(fake.client, {
      body: {
        uploadId: UPLOAD_ID,
        path: 'uploads/other-user/private.png',
        sizeBytes: 1,
      },
      userId: 'user-1',
    })).resolves.toMatchObject({
      ok: false,
      status: 400,
      code: 'INVALID_UPLOAD_FINALIZER',
    });
    expect(fake.from).not.toHaveBeenCalled();
  });

  it('refuses a non-canonical reservation path before privileged storage work', async () => {
    const fake = createClient({
      row: reservation({ storage_path: 'user-1%252fother/private.png' }),
    });

    await expect(finalizeUploadRequest(fake.client, {
      body: { uploadId: UPLOAD_ID },
      userId: 'user-1',
    })).resolves.toMatchObject({
      ok: false,
      status: 500,
      code: 'UPLOAD_FINALIZATION_UNAVAILABLE',
    });
    expect(fake.storageInfo).not.toHaveBeenCalled();
  });

  it('never revives a reservation released after signing failed', async () => {
    const fake = createClient({
      row: reservation({
        finalization_status: 'released',
        released_at: '2026-08-19T00:00:00.000Z',
      }),
    });

    await expect(finalizeUploadRequest(fake.client, {
      body: { uploadId: UPLOAD_ID },
      userId: 'user-1',
    })).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: 'UPLOAD_NOT_READY',
    });
    expect(fake.storageInfo).not.toHaveBeenCalled();
    expect(fake.row?.released_at).toBe('2026-08-19T00:00:00.000Z');
  });

  it('keeps expired capacity charged when object deletion cannot be confirmed', async () => {
    const fake = createClient({
      row: reservation({
        bucket_id: 'generated_images',
        storage_path: 'user-1/reference.png',
        expires_at: '2026-08-18T00:00:00.000Z',
      }),
      info: {
        id: 'storage-object-1',
        version: 'storage-version-1',
        bucketId: 'generated_images',
        contentType: 'image/png',
        size: 1,
      },
      removeError: new Error('storage outage'),
    });

    await expect(reclaimExpiredUploadReservations(fake.client, {
      now: new Date('2026-08-20T00:00:00.000Z'),
    })).resolves.toEqual({
      scanned: 1,
      handled: 1,
      objectsDeleted: 0,
      absentObjectsReleased: 0,
      failed: 0,
      bytesDeleted: 0,
      scanLimitReached: false,
      timeBudgetReached: false,
      oldestCandidateExpiresAt: '2026-08-18T00:00:00.000Z',
    });

    expect(fake.remove).not.toHaveBeenCalled();
    expect(fake.row).toMatchObject({ finalization_status: 'reclaiming', released_at: null });

    await expect(reclaimExpiredUploadReservations(fake.client, {
      now: new Date('2026-08-20T00:11:00.000Z'),
    })).resolves.toEqual({
      scanned: 1,
      handled: 1,
      objectsDeleted: 0,
      absentObjectsReleased: 0,
      failed: 1,
      bytesDeleted: 0,
      scanLimitReached: false,
      timeBudgetReached: false,
      oldestCandidateExpiresAt: '2026-08-18T00:00:00.000Z',
    });

    expect(fake.remove).toHaveBeenCalledWith(['user-1/reference.png']);
    expect(fake.row).toMatchObject({ finalization_status: 'reclaiming', released_at: null });
  });

  it('tombstones a finalize-before-PUT reservation so a later object cannot be replayed', async () => {
    const fake = createClient({
      infoError: { status: 404, message: 'Object not found' },
    });

    await expect(finalizeUploadRequest(fake.client, {
      body: { uploadId: UPLOAD_ID },
      userId: 'user-1',
    })).resolves.toMatchObject({
      ok: false,
      status: 400,
      code: 'UPLOAD_NOT_FOUND',
    });
    expect(fake.row).toMatchObject({ finalization_status: 'deleted', released_at: null });
    expect(fake.storageInfo).toHaveBeenCalledTimes(1);

    fake.setInfo({
      id: 'late-object',
      version: 'late-version',
      bucketId: 'uploads',
      contentType: 'image/png',
      size: 1,
    });
    await expect(finalizeUploadRequest(fake.client, {
      body: { uploadId: UPLOAD_ID },
      userId: 'user-1',
    })).resolves.toMatchObject({
      ok: false,
      code: 'UPLOAD_NOT_FOUND',
    });
    expect(fake.storageInfo).toHaveBeenCalledTimes(1);
  });

  it('deletes a replacement without rebinding an already-finalized object identity', async () => {
    const fake = createClient({
      row: reservation({
        finalization_status: 'finalized',
        finalized_at: '2026-08-19T10:00:00.000Z',
        actual_bytes: 1,
        actual_content_type: 'image/png',
        actual_storage_id: 'original-object',
        actual_storage_version: 'original-version',
      }),
      info: {
        id: 'replacement-object',
        version: 'replacement-version',
        bucketId: 'uploads',
        contentType: 'image/png',
        size: 1,
      },
    });

    await expect(finalizeUploadRequest(fake.client, {
      body: { uploadId: UPLOAD_ID },
      userId: 'user-1',
    })).resolves.toMatchObject({
      ok: false,
      status: 400,
      code: 'UPLOAD_METADATA_MISMATCH',
    });
    expect(fake.remove).toHaveBeenCalledWith(['user-1/reference.png']);
    expect(fake.row).toMatchObject({
      finalization_status: 'deleted',
      actual_storage_id: 'original-object',
      actual_storage_version: 'original-version',
    });
  });

  it('does not interpret an empty delete result or misleading 500 text as absence', async () => {
    const fake = createClient({
      removeData: [],
      infoError: { status: 500, message: 'relation does not exist / object not found' },
    });

    await expect(deleteReservedObjectAndConfirm(
      fake.client,
      'uploads',
      'user-1/reference.png',
    )).resolves.toBe(false);
  });

  it('reuses an exact consumed preserve object without acquiring another lease', async () => {
    const fake = createClient({
      row: reservation({
        finalization_status: 'consumed',
        finalized_at: '2026-08-19T10:00:00.000Z',
        consumed_at: '2026-08-19T10:01:00.000Z',
        consumption_disposition: 'preserve',
        actual_bytes: 1,
        actual_content_type: 'image/png',
        actual_storage_id: 'storage-object-1',
        actual_storage_version: 'storage-version-1',
        released_at: '2026-08-19T10:02:00.000Z',
      }),
    });

    await expect(finalizeUploadForConsumption(fake.client, {
      bucket: 'uploads',
      storagePath: 'user-1/reference.png',
      userId: 'user-1',
      disposition: 'preserve',
    })).resolves.toMatchObject({
      ok: true,
      reservationId: null,
      consumptionClaim: null,
      descriptor: {
        storagePath: 'uploads/user-1/reference.png',
      },
    });
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it('retains an active consumption lease and never lets the reclaimer inspect its object', async () => {
    const fake = createClient({
      row: reservation({
        bucket_id: 'generated_images',
        finalization_status: 'consuming',
        finalized_at: '2026-08-19T09:30:00.000Z',
        actual_bytes: 1,
        actual_content_type: 'image/png',
        actual_storage_id: 'storage-object-1',
        actual_storage_version: 'storage-version-1',
        consumption_disposition: 'preserve',
        consumption_lease_id: '22222222-2222-4222-8222-222222222222',
        consumption_lease_expires_at: '2026-08-20T01:00:00.000Z',
        expires_at: '2026-08-19T00:00:00.000Z',
      }),
    });

    await expect(reclaimExpiredUploadReservations(fake.client, {
      now: new Date('2026-08-20T00:00:00.000Z'),
    })).resolves.toMatchObject({ failed: 0, objectsDeleted: 0 });
    expect(fake.row?.finalization_status).toBe('consuming');
    expect(fake.storageInfo).not.toHaveBeenCalled();
    expect(fake.remove).not.toHaveBeenCalled();
  });

  it('quarantines an expired exact consumption outcome and permits a fresh same-disposition lease', async () => {
    const fake = createClient({
      row: reservation({
        bucket_id: 'generated_images',
        finalization_status: 'consuming',
        finalized_at: '2026-08-19T09:30:00.000Z',
        actual_bytes: 1,
        actual_content_type: 'image/png',
        actual_storage_id: 'storage-object-1',
        actual_storage_version: 'storage-version-1',
        consumption_disposition: 'delete',
        consumption_lease_id: '22222222-2222-4222-8222-222222222222',
        consumption_lease_expires_at: '2026-08-19T23:00:00.000Z',
        expires_at: '2026-08-19T00:00:00.000Z',
      }),
      info: {
        id: 'storage-object-1',
        version: 'storage-version-1',
        bucketId: 'generated_images',
        contentType: 'image/png',
        size: 1,
      },
    });

    await reclaimExpiredUploadReservations(fake.client, {
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    expect(fake.row).toMatchObject({
      finalization_status: 'consumed',
      consumption_disposition: 'delete',
      consumption_lease_id: null,
      consumption_lease_expires_at: null,
      released_at: null,
    });
    expect(fake.row?.consumption_outcome_unknown_at).toBeTruthy();
    expect(fake.remove).not.toHaveBeenCalled();

    await expect(finalizeUploadForConsumption(fake.client, {
      bucket: 'generated_images',
      storagePath: 'user-1/reference.png',
      userId: 'user-1',
      disposition: 'delete',
    })).resolves.toMatchObject({
      ok: true,
      reservationId: UPLOAD_ID,
      consumptionClaim: {
        uploadId: UPLOAD_ID,
        userId: 'user-1',
        disposition: 'delete',
      },
    });
    expect(fake.rpc).toHaveBeenCalledWith(
      'claim_upload_byte_reservation_consumption',
      expect.objectContaining({
        p_upload_id: UPLOAD_ID,
        p_user_id: 'user-1',
        p_disposition: 'delete',
      }),
    );
  });

  it('retains and charges legacy durable objects without repeatedly transitioning them', async () => {
    const fake = createClient({
      row: reservation({
        bucket_id: 'profiles',
        storage_path: 'user-1/avatar.png',
        expected_content_type: 'application/octet-stream',
        consumption_disposition: 'preserve',
        legacy_compatibility_mode: true,
        expires_at: '2026-08-18T00:00:00.000Z',
      }),
      info: {
        id: 'legacy-object',
        version: 'legacy-version',
        bucketId: 'profiles',
        contentType: 'image/png',
        size: 1,
      },
    });

    await reclaimExpiredUploadReservations(fake.client, {
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    await reclaimExpiredUploadReservations(fake.client, {
      now: new Date('2026-08-20T00:11:00.000Z'),
    });
    expect(fake.row).toMatchObject({
      finalization_status: 'consumed',
      consumption_disposition: 'preserve',
      actual_bytes: 1,
      actual_storage_id: 'legacy-object',
      released_at: null,
    });
    const transitionsAfterBinding = fake.updates.length;
    await reclaimExpiredUploadReservations(fake.client, {
      now: new Date('2026-08-20T01:00:00.000Z'),
    });
    // One scheduling-only update keeps this permanent compatibility row out of
    // every daily scan. It does not touch lifecycle or Storage state.
    expect(fake.updates).toHaveLength(transitionsAfterBinding + 1);
    expect(fake.row?.reclaim_after).toBe('2026-09-19T01:00:00.000Z');
    expect(fake.remove).not.toHaveBeenCalled();
  });

  it('deletes an unprotected legacy uploads staging object instead of preserving it forever', async () => {
    const fake = createClient({
      row: reservation({
        expected_content_type: 'application/octet-stream',
        consumption_disposition: 'draft',
        legacy_compatibility_mode: true,
        expires_at: '2026-08-18T00:00:00.000Z',
      }),
      intentRows: [{
        user_id: 'user-1',
        storage_path: 'user-1/reference.png',
        storage_cleared_at: '2026-08-19T00:00:00.000Z',
      }],
    });

    await reclaimExpiredUploadReservations(fake.client, {
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    await reclaimExpiredUploadReservations(fake.client, {
      now: new Date('2026-08-20T00:11:00.000Z'),
    });
    expect(fake.remove).toHaveBeenCalledWith(['user-1/reference.png']);
    expect(fake.row).toMatchObject({ finalization_status: 'deleted' });
    expect(fake.row?.released_at).toBeTruthy();
  });

  it('binds trusted actual bytes for a protected mobile draft, then releases only after clearing and deletion', async () => {
    const intents = [{
      user_id: 'user-1',
      storage_path: 'user-1/reference.png',
      storage_cleared_at: null as string | null,
    }];
    const fake = createClient({
      row: reservation({ expires_at: '2026-08-18T00:00:00.000Z' }),
      intentRows: intents,
    });

    await reclaimExpiredUploadReservations(fake.client, {
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    await reclaimExpiredUploadReservations(fake.client, {
      now: new Date('2026-08-20T00:11:00.000Z'),
    });
    expect(fake.row).toMatchObject({
      finalization_status: 'consumed',
      consumption_disposition: 'draft',
      actual_bytes: 1,
      actual_storage_id: 'storage-object-1',
      released_at: null,
    });
    expect(fake.remove).not.toHaveBeenCalled();

    await reclaimExpiredUploadReservations(fake.client, {
      now: new Date('2026-08-20T00:22:00.000Z'),
    });
    expect(fake.row?.finalization_status).toBe('consumed');

    intents[0]!.storage_cleared_at = '2026-08-20T00:23:00.000Z';
    await reclaimExpiredUploadReservations(fake.client, {
      now: new Date('2026-08-20T00:24:00.000Z'),
    });
    expect(fake.row?.finalization_status).toBe('reclaiming');
    await reclaimExpiredUploadReservations(fake.client, {
      now: new Date('2026-08-20T00:35:00.000Z'),
    });
    expect(fake.row).toMatchObject({ finalization_status: 'deleted' });
    expect(fake.remove).toHaveBeenCalledWith(['user-1/reference.png']);
    expect(fake.row?.released_at).toBeTruthy();
  });
});
