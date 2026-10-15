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
      items: [{ storagePath: 'uploads/creator-1/source.psd', title: 'Layered source' }],
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

  it('rejects a non-canonical path even when a persisted revision lists it', async () => {
    for (const storagePath of [
      'uploads/creator-1/../another-user/private.psd',
      'uploads/creator-1/%252fanother-user/private.psd',
      'uploads/creator-1/%255canother-user/private.psd',
      'uploads//creator-1/private.psd',
    ]) {
      const rpc = vi.fn();
      const maliciousDetail = {
        ...detail,
        purchasedRevision: {
          ...detail.purchasedRevision,
          resources: {
            ...detail.purchasedRevision.resources,
            items: [{ storagePath }],
          },
        },
      };

      const result = await createViewerUnlockFileUrl({
        adminSupabase: { rpc } as never,
        body: { storagePath },
        countryCode: null,
        getDetail: vi.fn(async () => maliciousDetail as never),
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
    }
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
          retained_path: `retained/${detail.purchasedRevision.revisionId}/source.psd`,
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
      `retained/${detail.purchasedRevision.revisionId}/source.psd`,
      600,
      { download: 'Layered source' },
    );
  });

  it('rejects a non-canonical retained mapping before signing it', async () => {
    const createSignedUrl = vi.fn();
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({
        data: {
          retained_bucket: 'post_resource_files',
          retained_path: `retained/${detail.purchasedRevision.revisionId}/%252fprivate.psd`,
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

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Retained resource file not found.' },
    });
    expect(admin.storage.from).not.toHaveBeenCalled();
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  // The `{ storagePaths }` batch form and the `disposition` field the post's
  // own file-url route takes (`post-resource-file-url-service.test.ts`), on
  // the buyer-library route.
  describe('batch form and disposition', () => {
    const livePaths = [
      'generation_inputs/creator-1/gen-1/00-reference-image.png',
      'generation_inputs/creator-1/gen-1/01-reference-video.mp4',
      'creator-1/resources/voice.mp3',
    ];
    const liveDetail = {
      unlockId: detail.unlockId,
      detached: false,
      creatorUserId: 'creator-1',
      currentResources: {
        attachments: [],
        items: [
          { storagePath: livePaths[0], title: 'Reference 1', contentType: 'image/png' },
          { storagePath: livePaths[1], title: 'Reference 2', contentType: 'video/mp4' },
          { storagePath: livePaths[2], title: 'Voice', contentType: 'audio/mpeg' },
        ],
      },
      purchasedRevision: {
        revisionId: detail.purchasedRevision.revisionId,
        resources: { attachments: [], items: [] },
      },
    };
    const signedUrlFor = (path: string) => `https://signed.example.test/${path}`;

    function createAdmin({
      allowed = true,
      failingPaths = [] as string[],
      mappings = {} as Record<string, string>,
    } = {}) {
      const rpc = vi.fn(async () => ({
        data: { allowed, limit: 120, remaining: allowed ? 119 : 0, retryAfterSeconds: allowed ? 0 : 18 },
        error: null,
      }));
      const createSignedUrl = vi.fn(async (path: string) => (failingPaths.includes(path)
        ? { data: null, error: new Error('storage outage') }
        : { data: { signedUrl: signedUrlFor(path) }, error: null }));
      // The retained copy of each source path a detached purchase kept.
      const from = vi.fn(() => {
        const filters: Record<string, unknown> = {};
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn((column: string, value: unknown) => {
            filters[column] = value;
            return builder;
          }),
          maybeSingle: vi.fn(async () => {
            const retainedPath = mappings[String(filters.source_path)];
            return {
              data: retainedPath ? { retained_bucket: 'post_resource_files', retained_path: retainedPath } : null,
              error: null,
            };
          }),
        };
        return builder;
      });
      const storageFrom = vi.fn(() => ({ createSignedUrl }));
      return {
        admin: { rpc, from, storage: { from: storageFrom } },
        createSignedUrl,
        from,
        rpc,
        storageFrom,
      };
    }

    function sign(admin: unknown, body: unknown, getDetail = vi.fn(async () => liveDetail as never)) {
      return createViewerUnlockFileUrl({
        adminSupabase: admin as never,
        body,
        countryCode: null,
        getDetail,
        rateLimitKey: 'buyer-1',
        unlockId: detail.unlockId,
        viewerUserId: 'buyer-1',
      });
    }

    it('signs every file with one entitlement load and one limit check, in the order asked', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-06-22T06:00:00.000Z'));
      try {
        const client = createAdmin();
        const getDetail = vi.fn(async () => liveDetail as never);

        // A repeated path is signed once.
        const result = await sign(client.admin, { storagePaths: [...livePaths, livePaths[0]], disposition: 'inline' }, getDetail);

        expect(result).toEqual({
          ok: true,
          body: {
            files: [
              {
                storagePath: livePaths[0],
                url: 'https://signed.example.test/creator-1/gen-1/00-reference-image.png',
                expiresAt: '2026-06-22T06:10:00.000Z',
              },
              {
                storagePath: livePaths[1],
                url: 'https://signed.example.test/creator-1/gen-1/01-reference-video.mp4',
                expiresAt: '2026-06-22T06:10:00.000Z',
              },
              {
                storagePath: livePaths[2],
                url: 'https://signed.example.test/creator-1/resources/voice.mp3',
                expiresAt: '2026-06-22T06:10:00.000Z',
              },
            ],
          },
        });
        expect(getDetail).toHaveBeenCalledTimes(1);
        expect(client.rpc).toHaveBeenCalledTimes(1);
        expect(client.createSignedUrl).toHaveBeenCalledTimes(3);
        // Inline: no download name, so the browser shows the file.
        expect(client.createSignedUrl).toHaveBeenCalledWith('creator-1/gen-1/00-reference-image.png', 600, {});
        expect(client.storageFrom).toHaveBeenCalledWith('generation_inputs');
        expect(client.storageFrom).toHaveBeenCalledWith('post_resource_files');
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the single form as it was: attachment by default, inline when asked', async () => {
      const client = createAdmin();

      await expect(sign(client.admin, { storagePath: livePaths[2] })).resolves.toEqual({
        ok: true,
        body: { success: true, signedUrl: 'https://signed.example.test/creator-1/resources/voice.mp3' },
      });
      expect(client.createSignedUrl).toHaveBeenLastCalledWith('creator-1/resources/voice.mp3', 600, { download: 'Voice.mp3' });

      await sign(client.admin, { storagePath: livePaths[2], disposition: 'inline' });
      expect(client.createSignedUrl).toHaveBeenLastCalledWith('creator-1/resources/voice.mp3', 600, {});
    });

    it('leaves out a path that is not on this unlock, and refuses a batch that names none', async () => {
      const client = createAdmin();

      const partial = await sign(client.admin, {
        storagePaths: [livePaths[0], 'creator-2/private.png', 'uploads/creator-1/../creator-2/x.png'],
      });
      expect(partial.ok && 'files' in partial.body ? partial.body.files.map((file) => file.storagePath) : partial)
        .toEqual([livePaths[0]]);

      const none = createAdmin();
      await expect(sign(none.admin, { storagePaths: ['creator-2/private.png'] })).resolves.toEqual({
        ok: false,
        status: 404,
        body: { error: 'Resource file not found on this unlock.' },
      });
      expect(none.rpc).not.toHaveBeenCalled();
      expect(none.createSignedUrl).not.toHaveBeenCalled();
    });

    it('rejects a malformed batch or disposition before any lookup', async () => {
      const tooMany = Array.from({ length: 26 }, (_, index) => `creator-1/resources/${index}.png`);
      const cases: Array<[unknown, string]> = [
        [{ storagePaths: [] }, 'Missing resource file path.'],
        [{ storagePaths: 'creator-1/resources/a.png' }, 'Missing resource file path.'],
        [{ storagePaths: ['creator-1/resources/a.png', 7] }, 'Missing resource file path.'],
        [{ storagePaths: [' creator-1/resources/a.png'] }, 'Missing resource file path.'],
        [{ storagePaths: tooMany }, 'Ask for at most 25 resource files at a time.'],
        [{ storagePath: 'creator-1/resources/a.png', disposition: 'download' }, 'Unknown file disposition.'],
      ];

      for (const [body, error] of cases) {
        const client = createAdmin();
        const getDetail = vi.fn();
        await expect(sign(client.admin, body, getDetail)).resolves.toEqual({ ok: false, status: 400, body: { error } });
        expect(getDetail).not.toHaveBeenCalled();
        expect(client.rpc).not.toHaveBeenCalled();
      }
    });

    it('answers the files that signed when one signing fails, and fails only when none did', async () => {
      const oneDown = createAdmin({ failingPaths: ['creator-1/gen-1/01-reference-video.mp4'] });
      const partial = await sign(oneDown.admin, { storagePaths: livePaths });
      expect(partial.ok && 'files' in partial.body ? partial.body.files.map((file) => file.storagePath) : partial)
        .toEqual([livePaths[0], livePaths[2]]);

      const allDown = createAdmin({
        failingPaths: ['creator-1/gen-1/00-reference-image.png', 'creator-1/gen-1/01-reference-video.mp4', 'creator-1/resources/voice.mp3'],
      });
      await expect(sign(allDown.admin, { storagePaths: livePaths }))
        .resolves.toEqual({ ok: false, status: 500, body: { error: 'Failed to prepare resource file.' } });
    });

    it('signs each retained copy of a detached purchase, leaving out a file it did not keep', async () => {
      const detachedDetail = {
        ...detail,
        purchasedRevision: {
          ...detail.purchasedRevision,
          resources: {
            ...detail.purchasedRevision.resources,
            items: [{ storagePath: 'uploads/creator-1/source.psd' }, { storagePath: 'uploads/creator-1/lost.psd' }],
          },
        },
      };
      const revision = detail.purchasedRevision.revisionId;
      const client = createAdmin({ mappings: { 'creator-1/source.psd': `retained/${revision}/source.psd` } });

      const result = await sign(
        client.admin,
        { storagePaths: ['uploads/creator-1/source.psd', 'uploads/creator-1/lost.psd'] },
        vi.fn(async () => detachedDetail as never),
      );

      expect(result.ok && 'files' in result.body ? result.body.files.map((file) => [file.storagePath, file.url]) : result)
        .toEqual([['uploads/creator-1/source.psd', `https://signed.example.test/retained/${revision}/source.psd`]]);
      expect(client.from).toHaveBeenCalledTimes(2);
      expect(client.rpc).toHaveBeenCalledTimes(1);

      // Asked for alone, the lost file answers as it always has.
      await expect(sign(
        createAdmin().admin,
        { storagePath: 'uploads/creator-1/lost.psd' },
        vi.fn(async () => detachedDetail as never),
      )).resolves.toEqual({ ok: false, status: 404, body: { error: 'Retained resource file not found.' } });
    });

    it('names a download as the post route does, from the current version or the purchased one', async () => {
      const client = createAdmin();
      const namedDetail = {
        ...liveDetail,
        currentResources: {
          ...liveDetail.currentResources,
          attachments: [{
            kind: 'file',
            label: 'Workflow',
            storagePath: 'creator-1/resources/flow.json',
            contentType: 'application/json',
          }],
        },
        purchasedRevision: {
          ...liveDetail.purchasedRevision,
          resources: {
            attachments: [],
            items: [{ storagePath: 'creator-1/resources/old-notes.md', title: 'Notes they paid for', contentType: 'text/markdown' }],
          },
        },
      };
      const download = (storagePath: string) => sign(client.admin, { storagePath }, vi.fn(async () => namedDetail as never));

      await download(livePaths[0]);
      expect(client.createSignedUrl).toHaveBeenLastCalledWith('creator-1/gen-1/00-reference-image.png', 600, { download: 'Reference 1.png' });
      await download('creator-1/resources/flow.json');
      expect(client.createSignedUrl).toHaveBeenLastCalledWith('creator-1/resources/flow.json', 600, { download: 'Workflow.json' });
      await download('creator-1/resources/old-notes.md');
      expect(client.createSignedUrl).toHaveBeenLastCalledWith('creator-1/resources/old-notes.md', 600, { download: 'Notes they paid for.md' });
    });

    it('counts a denied batch once and signs nothing', async () => {
      const denied = createAdmin({ allowed: false });

      const result = await sign(denied.admin, { storagePaths: livePaths });

      expect(result).toHaveProperty('rateLimitError');
      expect(denied.rpc).toHaveBeenCalledTimes(1);
      expect(denied.createSignedUrl).not.toHaveBeenCalled();
    });
  });
});
