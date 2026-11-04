import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  finish: vi.fn(),
  markStage: vi.fn(),
  log: vi.fn(),
}));

vi.mock('@/lib/account-deletion-service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startInitialAccountDeletion: mocks.start,
  finishInitialAccountDeletion: mocks.finish,
  markAccountDeletionStage: mocks.markStage,
}));
vi.mock('@/lib/backend-logger', () => ({ logBackendError: mocks.log }));
vi.mock('@/lib/upload-finalization', () => ({ reclaimExpiredUploadReservations: vi.fn() }));

import { AccountDeletionNotStartedError, GuestAccountLinkedError } from '@/lib/account-deletion-service';
import { retireGuestThroughAccountDeletion } from '@/lib/operational-data-retention';

const admin = { rpc: vi.fn() } as unknown as SupabaseClient;
const userId = '00000000-0000-4000-8000-000000000001';
const manifest = { ownerUserIds: [userId] };

// A guest with content goes down the pipeline a guest's own deletion takes:
// prepared as a guest, then the storage sweep and the Auth delete.
describe('retiring one guest through the account-deletion pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markStage.mockResolvedValue('failed');
  });

  it('prepares it as a guest and finishes the deletion with the manifest it was given', async () => {
    mocks.start.mockResolvedValue({ status: 'started', manifest });
    mocks.finish.mockResolvedValue({ alreadyCompleted: false, authUserAlreadyMissing: false, cleanupPending: true });

    await expect(retireGuestThroughAccountDeletion(admin, userId)).resolves.toBe('retired');

    expect(mocks.start).toHaveBeenCalledWith({ admin, userId, identityKind: 'guest' });
    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ admin, userId, manifest }));
    expect(mocks.markStage).not.toHaveBeenCalled();
  });

  it('answers a deletion that already happened without doing it again', async () => {
    mocks.start.mockResolvedValue({ status: 'already_deleted', result: { alreadyCompleted: true } });

    await expect(retireGuestThroughAccountDeletion(admin, userId)).resolves.toBe('already_deleted');
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it('leaves a refusal unmarked: nothing was changed and there is no job', async () => {
    for (const refusal of [new GuestAccountLinkedError(), new AccountDeletionNotStartedError('not_a_guest')]) {
      mocks.start.mockRejectedValueOnce(refusal);

      await expect(retireGuestThroughAccountDeletion(admin, userId)).rejects.toBe(refusal);
    }
    expect(mocks.markStage).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it('marks a deletion that failed after it began, so the resweep job finishes it', async () => {
    const failure = new Error('Storage unavailable');
    mocks.start.mockResolvedValue({ status: 'started', manifest });
    mocks.finish.mockRejectedValue(failure);

    await expect(retireGuestThroughAccountDeletion(admin, userId)).rejects.toBe(failure);
    expect(mocks.markStage).toHaveBeenCalledWith(admin, userId, 'failed', failure);
  });

  it('marks a start that failed after the preparation committed', async () => {
    const failure = new Error('Could not persist account deletion stage storage_deleting.');
    mocks.start.mockRejectedValue(failure);

    await expect(retireGuestThroughAccountDeletion(admin, userId)).rejects.toBe(failure);
    expect(mocks.markStage).toHaveBeenCalledWith(admin, userId, 'failed', failure);
  });

  it('still reports the deletion\'s own failure when marking it fails too', async () => {
    const failure = new Error('Storage unavailable');
    mocks.start.mockResolvedValue({ status: 'started', manifest });
    mocks.finish.mockRejectedValue(failure);
    mocks.markStage.mockRejectedValue(new Error('database unavailable'));

    await expect(retireGuestThroughAccountDeletion(admin, userId)).rejects.toBe(failure);
    expect(mocks.log).toHaveBeenCalledWith('operational_retention_content_guest_stage_failed', expect.objectContaining({ userId }));
  });
});
