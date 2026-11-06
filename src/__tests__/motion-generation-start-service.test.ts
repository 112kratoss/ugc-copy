import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createRemixSourceRows } from '@/__tests__/fixtures/remix-source-rows';
import { buildGenerationModelCatalog, CatalogError } from '@/lib/generation-model-catalog';
import {
  MotionGenerationStartValidationError,
  startMotionGenerationForRoute,
  type MotionGenerationStartRouteClient,
} from '@/lib/motion-generation-start-service';
import { ReferenceDurationChangedError } from '@/lib/unified-generation-start-service';

const startMotionGenerationMock = vi.hoisted(() => vi.fn());
const resolveGenerationMediaSourceMock = vi.hoisted(() => vi.fn());
const probeMediaDurationSecondsMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/generation-services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/generation-services')>();
  return {
    ...actual,
    resolveGenerationMediaSource: resolveGenerationMediaSourceMock,
    startMotionGeneration: startMotionGenerationMock,
  };
});

// ffmpeg reads the clip; these tests decide what it finds.
vi.mock('@/lib/video-rendition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/video-rendition')>()),
  probeMediaDurationSeconds: probeMediaDurationSecondsMock,
}));

type SourceGenerationRow = {
  id: string;
  user_id: string;
  is_public: boolean;
};

type ExistingGenerationRow = {
  id: string;
  prediction_id: string;
  status: string;
  cost: number;
};

function createClientMock({
  sourceGeneration = null,
  rateLimitAllowed = true,
  existingGeneration = null,
}: {
  sourceGeneration?: SourceGenerationRow | null;
  rateLimitAllowed?: boolean;
  /** The generation that already holds the request key: a start that was accepted. */
  existingGeneration?: ExistingGenerationRow | null;
} = {}) {
  const remixSourceRows = createRemixSourceRows(sourceGeneration);
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'check_backend_rate_limit') {
      return {
        data: {
          allowed: rateLimitAllowed,
          limit: 30,
          remaining: rateLimitAllowed ? 29 : 0,
          retryAfterSeconds: rateLimitAllowed ? 0 : 45,
          resetAt: '2026-06-22T07:00:00.000Z',
        },
        error: null,
      };
    }

    if (fn === 'try_acquire_backend_job_lock') {
      return { data: true, error: null };
    }

    if (fn === 'release_backend_job_lock') {
      return { data: true, error: null };
    }

    if (fn === 'claim_generation_start_request') {
      return { data: 'claimed', error: null };
    }

    return { data: null, error: null };
  });

  const from = vi.fn((table: string) => {
    if (table === 'profiles' && existingGeneration) {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { credits: 70 }, error: null }) }),
        }),
      };
    }
    if (table !== 'generations') {
      // Refuses any table but those Remix reads.
      return remixSourceRows.client.from(table);
    }

    return {
      select() {
        const filters: Record<string, unknown> = {};
        const query = {
          eq(column: string, value: unknown) {
            filters[column] = value;
            return query;
          },
          or() {
            return query;
          },
          async maybeSingle() {
            if (filters.id && sourceGeneration?.id === filters.id) {
              return { data: sourceGeneration, error: null };
            }
            if (filters.client_request_key_hash && existingGeneration) {
              return { data: existingGeneration, error: null };
            }

            return { data: null, error: null };
          },
        };

        return query;
      },
    };
  });

  return {
    rpc,
    from,
    client: { rpc, from } as unknown as MotionGenerationStartRouteClient,
  };
}

describe('startMotionGenerationForRoute', () => {
  const catalogRevision = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 1 }).revision;
  const resolvedReference = 'https://project.supabase.co/storage/v1/object/sign/uploads/user-1/reference.mp4?token=t';

  beforeEach(() => {
    startMotionGenerationMock.mockReset();
    resolveGenerationMediaSourceMock.mockReset();
    probeMediaDurationSecondsMock.mockReset();
    resolveGenerationMediaSourceMock.mockResolvedValue(resolvedReference);
    probeMediaDurationSecondsMock.mockResolvedValue(5.2);
  });

  /** A kling-2.6 or kling-3.0 run with both inputs, naming `duration` for its clip. */
  function motionBody(overrides: Record<string, unknown> = {}) {
    return {
      prompt: 'Transfer the performance naturally.',
      model: 'kling-3.0',
      characterImageUrl: 'https://signed.example.com/character.png',
      referenceVideoUrl: 'https://signed.example.com/reference.mp4',
      mode: '1080p',
      catalogRevision,
      ...overrides,
    };
  }

  it('rejects stale catalog revisions before rate limits or provider starts', async () => {
    const userClient = createClientMock();
    const adminClient = createClientMock();

    await expect(startMotionGenerationForRoute({
      request: new Request('http://localhost/api/generate'),
      body: {
        prompt: 'Transfer the performance naturally.',
        model: 'kling-2.6',
        characterImageUrl: 'https://signed.example.com/character.png',
        referenceVideoUrl: 'https://signed.example.com/reference.mp4',
        catalogRevision: 'stale-revision',
      },
      userId: 'user-1',
      callerIsGuest: false,
      supabase: userClient.client,
      adminSupabase: adminClient.client,
    })).rejects.toBeInstanceOf(CatalogError);

    expect(adminClient.rpc).not.toHaveBeenCalled();
    expect(probeMediaDurationSecondsMock).not.toHaveBeenCalled();
    expect(startMotionGenerationMock).not.toHaveBeenCalled();
  });

  it('validates source access, rate limits, and starts with the server quote', async () => {
    startMotionGenerationMock.mockResolvedValueOnce({
      predictionId: 'task-motion-1',
      generationId: 'gen-motion-1',
      remainingCredits: 88,
      cost: 12,
    });
    const userClient = createClientMock();
    // The source-generation row is readable only service-role since the
    // 2026-07-26 grant hardening, so the fixture lives on the admin client.
    const adminClient = createClientMock({
      sourceGeneration: {
        id: '3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b',
        user_id: 'creator-1',
        is_public: true,
      },
    });

    const result = await startMotionGenerationForRoute({
      request: new Request('http://localhost/api/generate', {
        headers: { 'idempotency-key': 'motion-start-1' },
      }),
      body: {
        prompt: 'Transfer the performance naturally.',
        model: 'kling-3.0',
        characterImageUrl: 'https://signed.example.com/character.png',
        referenceVideoUrl: 'https://signed.example.com/reference.mp4',
        duration: 6,
        characterOrientation: 'image',
        mode: '1080p',
        characterImage: {
          kind: 'image',
          label: 'Character image',
          storagePath: 'uploads/user-1/character.png',
        },
        referenceVideo: {
          kind: 'video',
          label: 'Reference video',
          sourceGenerationId: 'source-video-1',
        },
        sourceGenerationId: '3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b',
        catalogRevision,
      },
      userId: 'user-1',
      callerIsGuest: false,
      supabase: userClient.client,
      adminSupabase: adminClient.client,
    });

    expect(adminClient.rpc).toHaveBeenCalledWith('check_backend_rate_limit', expect.objectContaining({
      p_scope: 'media-generation:start',
      p_subject_key: 'user-1',
      p_limit: 30,
    }));
    expect(startMotionGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      model: 'kling-3.0',
      prompt: 'Transfer the performance naturally.',
      // Each input as the caller sent it, which the start resolves, with the link the clip was
      // measured from: the start sends that one rather than resolve the clip again.
      referenceVideoUrl: 'https://signed.example.com/reference.mp4',
      characterImageUrl: 'https://signed.example.com/character.png',
      resolvedMediaSources: new Map([['https://signed.example.com/reference.mp4', resolvedReference]]),
      duration: 6,
      characterOrientation: 'image',
      mode: '1080p',
      quotedCostCredits: 162,
      sourceGenerationId: '3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b',
      characterImage: expect.objectContaining({
        kind: 'image',
        label: 'Character image',
      }),
      referenceVideo: expect.objectContaining({
        kind: 'video',
        label: 'Reference video',
      }),
    }));
    expect(result).toEqual({
      success: true,
      predictionId: 'task-motion-1',
      generationId: 'gen-motion-1',
      status: 'processing',
      remainingCredits: 88,
      cost: 12,
    });
    // The clip measured is the one the caller owns, resolved as the provider fetches it.
    expect(resolveGenerationMediaSourceMock).toHaveBeenCalledWith(
      userClient.client,
      'https://signed.example.com/reference.mp4',
      'user-1',
      // The start's one read of each unlock, which a character restored from a recipe's copy shares.
      { recipeCopyReads: expect.any(Map) },
    );
    expect(probeMediaDurationSecondsMock).toHaveBeenCalledWith(resolvedReference);
  });

  it('charges the length the clip measures, whatever duration the caller names', async () => {
    startMotionGenerationMock.mockResolvedValueOnce({
      predictionId: 'task-motion-2',
      generationId: 'gen-motion-2',
      remainingCredits: 500,
      cost: 216,
    });
    probeMediaDurationSecondsMock.mockResolvedValueOnce(7.3);

    await startMotionGenerationForRoute({
      request: new Request('http://localhost/api/generate', { headers: { 'idempotency-key': 'motion-start-2' } }),
      body: motionBody({ duration: 30 }),
      userId: 'user-1',
      callerIsGuest: false,
      supabase: createClientMock().client,
      adminSupabase: createClientMock().client,
    });

    // Kling 3.0 at 1080p is 27 credits a second: 8 s, not the 30 s the body named.
    expect(startMotionGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      duration: 8,
      quotedCostCredits: 216,
    }));
  });

  it('refuses, before any hold, a clip longer than the length the caller was quoted for', async () => {
    // The crafted request the old route took: pay for 1 second, send 30.
    probeMediaDurationSecondsMock.mockResolvedValueOnce(29.6);

    const refusal = await startMotionGenerationForRoute({
      request: new Request('http://localhost/api/generate', { headers: { 'idempotency-key': 'motion-start-3' } }),
      body: motionBody({ model: 'kling-2.6', mode: '720p', duration: 1 }),
      userId: 'user-1',
      callerIsGuest: false,
      supabase: createClientMock().client,
      adminSupabase: createClientMock().client,
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ReferenceDurationChangedError);
    expect(refusal).toMatchObject({
      status: 409,
      quotedCostCredits: 11,
      costCredits: 330,
      inputs: [{ index: 0, slot: 'referenceVideo', durationSeconds: 29.6 }],
    });
    expect(startMotionGenerationMock).not.toHaveBeenCalled();
  });

  // kling-2.6/motion-control and kling-3.0/motion-control take a clip of 3 to 30 seconds
  // (Kie, 2026-10-20). A shorter one was priced at 3, held, sent and refused.
  it('refuses, before any hold, a clip that measures under 3 seconds', async () => {
    probeMediaDurationSecondsMock.mockResolvedValueOnce(2.4);

    const refusal = await startMotionGenerationForRoute({
      request: new Request('http://localhost/api/generate', { headers: { 'idempotency-key': 'motion-start-6' } }),
      body: motionBody({ model: 'kling-2.6', mode: '720p', duration: 3 }),
      userId: 'user-1',
      callerIsGuest: false,
      supabase: createClientMock().client,
      adminSupabase: createClientMock().client,
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(MotionGenerationStartValidationError);
    expect(refusal).toMatchObject({
      status: 400,
      message: 'Kling 2.6 reference video must be at least 3 seconds long. The reference video runs 2.4 seconds.',
    });
    expect(startMotionGenerationMock).not.toHaveBeenCalled();
  });

  it('starts a clip of 3 seconds and tells the start how long it measured', async () => {
    startMotionGenerationMock.mockResolvedValueOnce({
      predictionId: 'task-motion-7',
      generationId: 'gen-motion-7',
      remainingCredits: 500,
      cost: 33,
    });
    probeMediaDurationSecondsMock.mockResolvedValueOnce(3);

    await startMotionGenerationForRoute({
      request: new Request('http://localhost/api/generate', { headers: { 'idempotency-key': 'motion-start-7' } }),
      body: motionBody({ model: 'kling-2.6', mode: '720p', duration: 3 }),
      userId: 'user-1',
      callerIsGuest: false,
      supabase: createClientMock().client,
      adminSupabase: createClientMock().client,
    });

    expect(startMotionGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      duration: 3,
      referenceVideoSeconds: 3,
    }));
  });

  it.each([
    ['ffmpeg finds no length', 'probe', null],
    ['the clip resolves to a link that is not HTTPS', 'source', 'uploads/user-1/reference.mp4'],
  ])('refuses a clip whose length cannot be verified when %s', async (_name, which, value) => {
    if (which === 'probe') probeMediaDurationSecondsMock.mockResolvedValueOnce(value);
    else resolveGenerationMediaSourceMock.mockResolvedValueOnce(value);

    const refusal = await startMotionGenerationForRoute({
      request: new Request('http://localhost/api/generate', { headers: { 'idempotency-key': 'motion-start-4' } }),
      body: motionBody({ duration: 6 }),
      userId: 'user-1',
      callerIsGuest: false,
      supabase: createClientMock().client,
      adminSupabase: createClientMock().client,
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(MotionGenerationStartValidationError);
    expect(refusal).toMatchObject({
      status: 422,
      message: 'The length of a reference file could not be verified. Upload it again, then retry.',
    });
    expect(probeMediaDurationSecondsMock).toHaveBeenCalledTimes(which === 'probe' ? 1 : 0);
    expect(startMotionGenerationMock).not.toHaveBeenCalled();
  });

  // The motion start resolves both its inputs, as the video start does, so this route resolves the
  // clip only, to measure it, and hands the start that link beside the clip as sent, with the reads
  // of each unlock that measuring made (#678: a character restored from a recipe's copy shares them).
  // It handed the start the links as resolved, which the start kept a remix's inputs by: as the
  // remixer's copies.
  it('resolves only the clip, to measure it, and hands the start the inputs as sent with that link', async () => {
    startMotionGenerationMock.mockResolvedValueOnce({
      predictionId: 'task-motion-8',
      generationId: 'gen-motion-8',
      remainingCredits: 500,
      cost: 162,
    });
    const userClient = createClientMock();

    await startMotionGenerationForRoute({
      request: new Request('http://localhost/api/generate', { headers: { 'idempotency-key': 'motion-start-8' } }),
      body: motionBody({ duration: 6 }),
      userId: 'user-1',
      callerIsGuest: false,
      supabase: userClient.client,
      adminSupabase: createClientMock().client,
    });

    expect(resolveGenerationMediaSourceMock.mock.calls).toEqual([
      [userClient.client, 'https://signed.example.com/reference.mp4', 'user-1', { recipeCopyReads: expect.any(Map) }],
    ]);
    expect(probeMediaDurationSecondsMock).toHaveBeenCalledWith(resolvedReference);
    expect(startMotionGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      supabase: userClient.client,
      characterImageUrl: 'https://signed.example.com/character.png',
      referenceVideoUrl: 'https://signed.example.com/reference.mp4',
      resolvedMediaSources: new Map([['https://signed.example.com/reference.mp4', resolvedReference]]),
    }));
    const [{ recipeCopyReads }] = startMotionGenerationMock.mock.calls[0] as [{ recipeCopyReads?: unknown }];
    expect(recipeCopyReads).toBe((resolveGenerationMediaSourceMock.mock.calls[0] as [unknown, string, string, { recipeCopyReads?: unknown }])[3].recipeCopyReads);
  });

  // The picture is held to what the clip is held to when it is measured: a link the provider can
  // fetch, and a refusal that says what to do, before anything is held. This route hands the picture
  // to the motion start, which resolves it, so these run the start itself behind the route.
  describe('a picture the start cannot send', () => {
    const STORAGE = 'https://project.supabase.co/storage/v1/object/sign';

    it.each([
      {
        label: 'another creator’s upload that no remix shares',
        picture: `${STORAGE}/uploads/creator-1/hero.png?token=t`,
        signs: true,
      },
      {
        label: 'the caller’s own, which storage would not sign again',
        picture: `${STORAGE}/generation_inputs/user-1/gen-0/00-character_image.png?token=t`,
        signs: false,
      },
    ])('refuses $label as a picture to add again, before anything is held', async ({ picture, signs }) => {
      vi.stubEnv('KIE_AI_API_KEY', 'test-key');
      vi.stubEnv('KIE_PROVIDER_WEBHOOK_SECRET', 'test-webhook-secret');
      vi.stubEnv('KIE_WEBHOOK_HMAC_KEY', 'hmac-key');
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
      vi.stubEnv('GENERATION_MODEL_CATALOG_SOURCE', 'code');
      vi.stubGlobal('fetch', vi.fn());
      // Neither picture is a recipe file: no kept row of the caller's marks one (#678's check, which
      // reads those rows as the service).
      vi.doMock('@/lib/generation-reference-copy-import', async (importOriginal) => ({
        ...await importOriginal<typeof import('@/lib/generation-reference-copy-import')>(),
        reuseRecipeFile: vi.fn(async () => null),
      }));
      onTestFinished(() => {
        vi.doUnmock('@/lib/generation-reference-copy-import');
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
      });
      // A fresh start module, which reads the provider settings stubbed above when it loads.
      vi.resetModules();
      const actual = await vi.importActual<typeof import('@/lib/generation-services')>('@/lib/generation-services');
      startMotionGenerationMock.mockImplementation(actual.startMotionGeneration);
      const { startMotionGenerationForRoute: startRoute } = await import('@/lib/motion-generation-start-service');
      const userClient = {
        ...createClientMock().client,
        storage: {
          from: vi.fn(() => ({
            createSignedUrl: vi.fn(async (filePath: string) => (signs
              ? { data: { signedUrl: `${STORAGE}/${filePath}?token=fresh` }, error: null }
              : { data: null, error: { message: 'The signing service is unavailable.' } })),
          })),
        },
      } as unknown as MotionGenerationStartRouteClient;
      const adminClient = createClientMock();

      const refusal = await startRoute({
        request: new Request('http://localhost/api/generate', { headers: { 'idempotency-key': 'motion-start-11' } }),
        body: motionBody({ characterImageUrl: picture, duration: 6 }),
        userId: 'user-1',
        callerIsGuest: false,
        supabase: userClient,
        adminSupabase: adminClient.client,
      }).then(() => null, (error: unknown) => error);

      expect(refusal).toMatchObject({
        status: 422,
        failureCode: 'invalid_input_media',
        message: 'The character picture could not be used. Add your own character picture, then retry.',
      });
      expect(adminClient.rpc.mock.calls.map(([fn]) => fn)).not.toContain('start_generation');
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('replays a start already accepted without reading its clip again', async () => {
    const adminClient = createClientMock({
      existingGeneration: { id: 'gen-motion-5', prediction_id: 'task-motion-5', status: 'processing', cost: 162 },
    });

    const result = await startMotionGenerationForRoute({
      request: new Request('http://localhost/api/generate', { headers: { 'idempotency-key': 'motion-start-5' } }),
      body: motionBody({ duration: 6 }),
      userId: 'user-1',
      callerIsGuest: false,
      supabase: createClientMock().client,
      adminSupabase: adminClient.client,
    });

    expect(result).toMatchObject({ predictionId: 'task-motion-5', idempotentReplay: true });
    expect(resolveGenerationMediaSourceMock).not.toHaveBeenCalled();
    expect(probeMediaDurationSecondsMock).not.toHaveBeenCalled();
    expect(startMotionGenerationMock).not.toHaveBeenCalled();
  });
});
