import { describe, expect, it, vi } from 'vitest';

import { createViewerUnlockFileUrl } from '@/lib/viewer-unlock-file-url-service';

const detail = {
  unlockId: '11111111-1111-4111-8111-111111111111',
  detached: true,
  currentResources: null,
  purchasedRevision: {
    revisionId: '22222222-2222-4222-8222-222222222222',
    resources: {
      promptText: null,
      notesMarkdown: null,
      workflowShareUrl: null,
      workflowSnapshot: null,
      attachments: [],
      allowRemix: false,
      items: [{ storagePath: 'uploads/creator-1/source.psd' }],
    },
  },
};

describe('viewer unlock file URLs', () => {
  it('rejects an arbitrary path before signing or rate limiting it', async () => {
    const rpc = vi.fn();
    const result = await createViewerUnlockFileUrl({
      adminSupabase: { rpc } as never,
      body: { storagePath: 'uploads/another-user/private.psd' },
      countryCode: null,
      getDetail: vi.fn(async () => detail as never),
      rateLimitKey: 'buyer-1',
      unlockId: detail.unlockId,
      viewerUserId: 'buyer-1',
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Resource file not found on this unlock.' },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('signs the neutral retained path for a detached purchase', async () => {
    const createSignedUrl = vi.fn(async () => ({
      data: { signedUrl: 'https://signed.example.test/retained' },
      error: null,
    }));
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({
        data: {
          retained_bucket: 'post_resource_files',
          retained_path: 'retained/revision/source.psd',
        },
        error: null,
      })),
    };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    const admin = {
      rpc: vi.fn(async () => ({
        data: { allowed: true, limit: 120, remaining: 119, retryAfterSeconds: 0 },
        error: null,
      })),
      from: vi.fn(() => builder),
      storage: { from: vi.fn(() => ({ createSignedUrl })) },
    };

    const result = await createViewerUnlockFileUrl({
      adminSupabase: admin as never,
      body: { storagePath: 'uploads/creator-1/source.psd' },
      countryCode: null,
      getDetail: vi.fn(async () => detail as never),
      rateLimitKey: 'buyer-1',
      unlockId: detail.unlockId,
      viewerUserId: 'buyer-1',
    });

    expect(result).toMatchObject({ ok: true, body: { signedUrl: 'https://signed.example.test/retained' } });
    expect(admin.storage.from).toHaveBeenCalledWith('post_resource_files');
    expect(createSignedUrl).toHaveBeenCalledWith(
      'retained/revision/source.psd',
      600,
      { download: 'source.psd' },
    );
  });
});
