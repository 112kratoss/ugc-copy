import { describe, expect, it, vi } from 'vitest';

import {
  abortUploadByteConsumption,
  claimUploadBytesForConsumption,
  completeUploadByteConsumption,
  DefinitiveSupabaseMutationRejection,
  isDefinitiveSupabaseMutationRejection,
  throwSupabaseMutationFailure,
  type UploadConsumptionClaim,
} from '@/lib/upload-byte-admission';

const UPLOAD_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '20000000-0000-4000-8000-000000000002';

function createClient(data: unknown = true, error: unknown = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  return { client: { rpc }, rpc };
}

describe('upload consumption lease contract', () => {
  it('distinguishes proven database rejection from acknowledgement-ambiguous outcomes', () => {
    const conflict = { error: { code: '23505', message: 'conflict' }, status: 409 };

    expect(isDefinitiveSupabaseMutationRejection(conflict)).toBe(true);
    expect(isDefinitiveSupabaseMutationRejection({
      error: new Error('connection reset after commit'),
      status: 0,
    })).toBe(false);
    expect(isDefinitiveSupabaseMutationRejection({
      error: new Error('gateway lost the acknowledgement'),
      status: 503,
    })).toBe(false);
    expect(isDefinitiveSupabaseMutationRejection({
      error: new Error('transport threw before returning a status'),
    })).toBe(false);

    expect(() => throwSupabaseMutationFailure(conflict))
      .toThrow(DefinitiveSupabaseMutationRejection);
    expect(() => throwSupabaseMutationFailure({
      error: new Error('connection reset after commit'),
      status: 0,
    })).toThrow('connection reset after commit');
  });

  it('binds the owner and intended disposition into the acquired lease', async () => {
    const { client, rpc } = createClient();

    const result = await claimUploadBytesForConsumption(client, {
      uploadId: UPLOAD_ID,
      userId: USER_ID,
      disposition: 'draft',
    });

    expect(result).toMatchObject({
      ok: true,
      claim: {
        uploadId: UPLOAD_ID,
        userId: USER_ID,
        leaseId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        disposition: 'draft',
      },
    });
    expect(rpc).toHaveBeenCalledWith('claim_upload_byte_reservation_consumption', {
      p_upload_id: UPLOAD_ID,
      p_user_id: USER_ID,
      p_lease_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      p_lease_seconds: 30 * 60,
      p_disposition: 'draft',
    });
  });

  it('refuses a caller-side disposition change without touching the database', async () => {
    const { client, rpc } = createClient();
    const claim: UploadConsumptionClaim = {
      uploadId: UPLOAD_ID,
      userId: USER_ID,
      leaseId: '30000000-0000-4000-8000-000000000003',
      disposition: 'preserve',
    };

    await expect(completeUploadByteConsumption(client, {
      claim,
      disposition: 'delete',
    })).resolves.toMatchObject({ ok: false, kind: 'conflict' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('uses the opaque lease for both completion and abort mutations', async () => {
    const completed = createClient();
    const aborted = createClient();
    const claim: UploadConsumptionClaim = {
      uploadId: UPLOAD_ID,
      userId: USER_ID,
      leaseId: '30000000-0000-4000-8000-000000000003',
      disposition: 'delete',
    };

    await expect(completeUploadByteConsumption(completed.client, {
      claim,
      disposition: 'delete',
    })).resolves.toEqual({ ok: true });
    expect(completed.rpc).toHaveBeenCalledWith('complete_upload_byte_reservation_consumption', {
      p_upload_id: UPLOAD_ID,
      p_user_id: USER_ID,
      p_lease_id: claim.leaseId,
      p_disposition: 'delete',
    });

    await expect(abortUploadByteConsumption(aborted.client, claim)).resolves.toEqual({ ok: true });
    expect(aborted.rpc).toHaveBeenCalledWith('abort_upload_byte_reservation_consumption', {
      p_upload_id: UPLOAD_ID,
      p_user_id: USER_ID,
      p_lease_id: claim.leaseId,
    });
  });

  it('fails closed when a lease mutation is refused or unavailable', async () => {
    const refused = createClient(false);
    const unavailable = createClient(null, new Error('database unavailable'));
    const claim: UploadConsumptionClaim = {
      uploadId: UPLOAD_ID,
      userId: USER_ID,
      leaseId: '30000000-0000-4000-8000-000000000003',
      disposition: 'preserve',
    };

    await expect(completeUploadByteConsumption(refused.client, {
      claim,
      disposition: 'preserve',
    })).resolves.toMatchObject({ ok: false, kind: 'conflict' });
    await expect(abortUploadByteConsumption(unavailable.client, claim)).resolves.toMatchObject({
      ok: false,
      kind: 'unavailable',
    });
  });
});
