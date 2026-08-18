import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createVideoPosterBuffer: vi.fn(),
  logBackendError: vi.fn(),
}));

vi.mock('@/lib/video-poster', () => ({
  createVideoPosterBuffer: (...args: unknown[]) => mocks.createVideoPosterBuffer(...args),
  createVideoPosterBufferFromFile: vi.fn(),
}));

vi.mock('@/lib/backend-logger', () => ({
  logBackendError: (...args: unknown[]) => mocks.logBackendError(...args),
  logBackendWarning: vi.fn(),
  logBackendInfo: vi.fn(),
}));

vi.mock('@/lib/generation-output-preview', () => ({
  createGenerationOutputPreview: vi.fn(),
}));

vi.mock('@/lib/post-media-preview', () => ({
  createPostMediaPreview: vi.fn(),
}));

vi.mock('@/lib/post-media-rendition', () => ({
  createPostMediaRendition: vi.fn(),
}));

type Row = Record<string, unknown>;

function createFakeSupabase(seed: {
  templates: Row[];
  downloads?: Record<string, Blob | null>;
}) {
  const calls = {
    downloads: [] as string[],
    uploads: [] as Array<{ path: string; options: Record<string, unknown> }>,
    updates: [] as Array<{ payload: Row; filters: Array<[string, string, unknown]> }>,
  };
  const client = {
    from(table: string) {
      if (table !== 'templates') throw new Error(`Unexpected table: ${table}`);
      const filters: Array<[string, string, unknown]> = [];
      let payload: Row | null = null;
      const finish = async () => {
        if (payload) {
          calls.updates.push({ payload, filters: [...filters] });
          return { data: null, error: null };
        }
        return { data: seed.templates, error: null };
      };
      const api = {
        select: () => api,
        update: (value: Row) => {
          payload = value;
          return api;
        },
        eq: (column: string, value: unknown) => {
          filters.push(['eq', column, value]);
          return api;
        },
        is: (column: string, value: unknown) => {
          filters.push(['is', column, value]);
          return api;
        },
        like: (column: string, value: unknown) => {
          filters.push(['like', column, value]);
          return api;
        },
        limit: () => finish(),
        then: (resolve: (value: unknown) => unknown) => finish().then(resolve),
      };
      return api;
    },
    storage: {
      from: (bucket: string) => ({
        download: async (objectPath: string) => {
          calls.downloads.push(`${bucket}/${objectPath}`);
          const blob = seed.downloads?.[objectPath];
          return blob
            ? { data: blob, error: null }
            : { data: null, error: new Error('missing object') };
        },
        upload: async (objectPath: string, _body: unknown, options: Record<string, unknown>) => {
          calls.uploads.push({ path: `${bucket}/${objectPath}`, options });
          return { error: null };
        },
      }),
    },
  } as never;
  return { client, calls };
}

describe('repairTemplateDemoPosters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createVideoPosterBuffer.mockResolvedValue(Buffer.from('poster-bytes'));
  });

  it('derives, stores, and records a poster for a video template missing one', async () => {
    const demo = new Blob(['video-bytes'], { type: 'video/mp4' });
    const fake = createFakeSupabase({
      templates: [{ id: 'template-1', video_url: 'template_assets/template-1/version-1/demo/output.mp4' }],
      downloads: { 'template-1/version-1/demo/output.mp4': demo },
    });

    const { repairTemplateDemoPosters } = await import('@/lib/media-preview-repair');
    const summary = await repairTemplateDemoPosters(fake.client);

    expect(summary).toEqual({ attempted: 1, completed: 1, failed: 0 });
    expect(fake.calls.downloads).toEqual(['template_assets/template-1/version-1/demo/output.mp4']);
    expect(mocks.createVideoPosterBuffer).toHaveBeenCalledWith(demo);
    expect(fake.calls.uploads).toEqual([{
      path: 'template_assets/template-1/version-1/demo/poster.webp',
      options: { contentType: 'image/webp', upsert: true },
    }]);
    expect(fake.calls.updates).toEqual([{
      payload: { thumbnail_url: 'template_assets/template-1/version-1/demo/poster.webp' },
      filters: [['eq', 'id', 'template-1'], ['is', 'thumbnail_url', null]],
    }]);
  });

  it('logs and skips a template whose poster cannot be derived without failing the sweep', async () => {
    const demo = new Blob(['video-bytes'], { type: 'video/mp4' });
    const fake = createFakeSupabase({
      templates: [{ id: 'template-broken', video_url: 'template_assets/template-broken/version-1/demo/output.mp4' }],
      downloads: { 'template-broken/version-1/demo/output.mp4': demo },
    });
    mocks.createVideoPosterBuffer.mockRejectedValue(new Error('corrupt video'));

    const { repairTemplateDemoPosters } = await import('@/lib/media-preview-repair');
    const summary = await repairTemplateDemoPosters(fake.client);

    expect(summary).toEqual({ attempted: 1, completed: 0, failed: 1 });
    expect(fake.calls.updates).toEqual([]);
    expect(mocks.logBackendError).toHaveBeenCalledWith(
      'failed_to_repair_template_demo_poster',
      expect.objectContaining({ templateId: 'template-broken' }),
    );
  });

  it('does nothing when every video template already has a thumbnail', async () => {
    const fake = createFakeSupabase({ templates: [] });
    const { repairTemplateDemoPosters, hasRepairableTemplateDemoPosters } = await import('@/lib/media-preview-repair');

    expect(await repairTemplateDemoPosters(fake.client)).toEqual({ attempted: 0, completed: 0, failed: 0 });
    expect(await hasRepairableTemplateDemoPosters(fake.client)).toBe(false);
  });

  it('reports repairable work so the cron gate schedules a run', async () => {
    const fake = createFakeSupabase({
      templates: [{ id: 'template-1', video_url: 'template_assets/template-1/version-1/demo/output.mp4' }],
    });
    const { hasRepairableTemplateDemoPosters } = await import('@/lib/media-preview-repair');
    expect(await hasRepairableTemplateDemoPosters(fake.client)).toBe(true);
  });
});

describe('publish-time poster seam', () => {
  const serviceSource = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/media-template-service.ts'),
    'utf8',
  );
  const repairSource = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/media-preview-repair.ts'),
    'utf8',
  );
  const nextConfig = fs.readFileSync(path.join(process.cwd(), 'next.config.ts'), 'utf8');
  const ffmpegCheck = fs.readFileSync(
    path.join(process.cwd(), 'scripts/check-ffmpeg-build-artifact.mjs'),
    'utf8',
  );

  it('derives the poster from the demo blob for video templates at publish', () => {
    expect(serviceSource).toContain("compiled.outputKind === 'video'");
    expect(serviceSource).toContain('createTemplateDemoPosterAsset');
    expect(serviceSource).toContain('createVideoPosterBuffer(params.demoBlob)');
  });

  it('cleans the poster up with the other version assets when activation fails', () => {
    expect(serviceSource).toContain('if (demoPosterPath) copied.copiedPaths.push(demoPosterPath);');
  });

  it('records the poster only after this request activated the version', () => {
    expect(serviceSource).toContain("if (activation.inserted === true && demoPosterPath) {");
    expect(serviceSource).toMatch(/thumbnail_url: `template_assets\/\$\{demoPosterPath\}`/);
  });

  it('runs the template poster sweep with the light preview pass and gates the cron on it', () => {
    expect(repairSource).toContain('await repairTemplateDemoPosters(supabase)');
    expect(repairSource).toContain('if (await hasRepairableTemplateDemoPosters(supabase)) return true;');
  });

  it('bundles ffmpeg into the template publish route and verifies it at build time', () => {
    expect(nextConfig).toContain('"/api/templates/*/publish"');
    expect(ffmpegCheck).toContain("'app/api/templates/[id]/publish/route.js.nft.json'");
  });
});
