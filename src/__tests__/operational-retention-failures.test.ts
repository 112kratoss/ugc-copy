import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ log: vi.fn(), reclaim: vi.fn() }));
vi.mock('@/lib/backend-logger', () => ({ logBackendError: mocks.log }));
vi.mock('@/lib/upload-finalization', () => ({ reclaimExpiredUploadReservations: mocks.reclaim }));
import { pruneOperationalBackendData } from '@/lib/operational-data-retention';

const supplementary = [
  'prune_post_share_events',
  'prune_profile_share_events',
  'prune_abandoned_free_unlock_orders',
  'prune_account_merge_tickets',
  'prune_upload_byte_reservations',
];
const allCalls = ['prune_operational_backend_data', ...supplementary];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reclaim.mockResolvedValue({ scanned: 0, handled: 0, objectsDeleted: 0, failed: 0, deferred: 0, firstClaims: 0, held: 0, scanLimitReached: false, timeBudgetReached: false, oldestCandidateExpiresAt: null });
});

describe('supplementary retention failure visibility and progress', () => {
  for (const mode of ['result', 'rejection'] as const) {
    it.each(supplementary)(`records a ${mode} from %s and still reaches later work`, async (failedFunction) => {
      const error = new Error('retention fixture failure');
      const rpc = vi.fn(async (name: string) => {
        if (name === failedFunction) {
          if (mode === 'rejection') throw error;
          return { data: null, error };
        }
        return { data: name === 'prune_operational_backend_data' ? { total_deleted: 12, job_runs_deleted: 12 } : 3, error: null };
      });
      const summary = await pruneOperationalBackendData({ rpc } as unknown as SupabaseClient);
      expect(summary).toMatchObject({ totalDeleted: 12, jobRunsDeleted: 12, supplementaryPruneFailures: [failedFunction] });
      expect(rpc.mock.calls.map(([name]) => name)).toEqual(allCalls);
      expect(mocks.reclaim).toHaveBeenCalledOnce();
      expect(mocks.log).toHaveBeenCalledWith('operational_retention_supplementary_prune_failed', { operation: failedFunction, error });
    });
  }

  it('still stops before bookkeeping prune when object reclamation fails', async () => {
    mocks.reclaim.mockRejectedValueOnce(new Error('object reclamation failed'));
    const rpc = vi.fn(async (name: string) => ({ data: name === 'prune_operational_backend_data' ? { total_deleted: 1 } : 0, error: null }));
    await expect(pruneOperationalBackendData({ rpc } as unknown as SupabaseClient)).rejects.toThrow('object reclamation failed');
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain('prune_upload_byte_reservations');
  });

  it('does not carry old failures into a successful retry', async () => {
    let fail = true;
    const rpc = vi.fn(async (name: string) => ({
      data: name === 'prune_operational_backend_data' ? { total_deleted: 1 } : 1,
      error: fail && name === supplementary[0] ? new Error('temporary fixture failure') : null,
    }));
    const client = { rpc } as unknown as SupabaseClient;
    expect(await pruneOperationalBackendData(client)).toMatchObject({ supplementaryPruneFailures: [supplementary[0]], shareEventsDeleted: 0 });
    fail = false;
    expect(await pruneOperationalBackendData(client)).toMatchObject({ supplementaryPruneFailures: [], shareEventsDeleted: 1 });
  });
});
