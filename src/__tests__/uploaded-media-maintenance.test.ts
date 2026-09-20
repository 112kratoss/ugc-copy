import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { processUploadedMediaMaintenance } from '@/lib/uploaded-media-maintenance';

const publicPath = 'posts/b9100000-0000-4000-8000-000000000001/video.mp4';
const privatePath = `private-${publicPath}`;
function fixture({ copied = false, referenced = false, exists = false, removeError = null }: {
  copied?: boolean; referenced?: boolean | null; exists?: boolean | null; removeError?: Error | null;
} = {}) {
  const deleted = vi.fn();
  const updated = vi.fn();
  const remove = vi.fn(async () => ({ error: removeError }));
  const from = (table: string) => ({
    select: () => {
      const query = { is: () => query, order: () => query, limit: async () => ({ error: null, data:
        table === 'uploaded_media_private_copies'
          ? copied ? [{ public_path: publicPath, private_path: privatePath }] : []
          : [{ storage_path: privatePath }],
      }) };
      return query;
    },
    update: () => ({ eq: async () => { updated(table); return { error: null }; } }),
    delete: () => ({ eq: async () => { deleted(table); return { error: null }; } }),
  });
  const admin = {
    from,
    rpc: vi.fn(async () => ({ data: referenced, error: null })),
    storage: { from: vi.fn(() => ({ remove, exists: async () => ({ data: exists, error: null }) })) },
  };
  return { admin: admin as unknown as SupabaseClient, remove, deleted, updated };
}
describe('uploaded media maintenance', () => {
  it('retains a newly referenced private file and clears its obsolete cleanup ticket', async () => {
    const f = fixture({ referenced: true });
    expect(await processUploadedMediaMaintenance(f.admin)).toMatchObject({ retainedPrivateObjects: 1 });
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.deleted).toHaveBeenCalledWith('post_media_object_cleanup');
  });
  it('keeps failed public revocations pending for retry', async () => {
    const f = fixture({ copied: true, removeError: new Error('storage unavailable') });
    await expect(processUploadedMediaMaintenance(f.admin)).rejects.toThrow('storage unavailable');
    expect(f.updated).not.toHaveBeenCalled();
    expect(f.deleted).not.toHaveBeenCalled();
  });
  it('does not acknowledge deletion if Storage still contains the file', async () => {
    const f = fixture({ exists: true });
    await expect(processUploadedMediaMaintenance(f.admin)).rejects.toThrow('still exists');
    expect(f.deleted).not.toHaveBeenCalled();
  });
  it('fails closed when reference state cannot be established', async () => {
    const f = fixture({ referenced: null });
    await expect(processUploadedMediaMaintenance(f.admin)).rejects.toThrow('verify media references');
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.deleted).not.toHaveBeenCalled();
  });
});
