import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { resolveTemplateRunMedia, type TemplateMediaGeneration } from '@/lib/template-run-media-delivery';

vi.mock('@/lib/server-helpers', () => ({ resolveOwnedStoredMediaUrl: vi.fn(async (_client, value) => `https://single.test/${value}`) }));
const original = 'generated_videos/owner/clip.mp4';
const rendition = 'generated_videos/owner/playback/gen/clip.mp4';
const preview = 'generated_videos/owner/clip.preview.hash.webp';
const generation: TemplateMediaGeneration = { id: 'gen', user_id: 'owner', template_run_id: 'run', output_url: original,
  playback_rendition_path: rendition, playback_rendition_source: original, playback_rendition_status: 'ready', preview_url: preview, preview_status: 'ready' };
function fixture() {
  const sign = vi.fn(async (paths: string[]) => ({ data: paths.map(path => ({ path, signedUrl: `https://signed.test/${path}`, error: null })), error: null }));
  const from = vi.fn(() => ({ createSignedUrls: sign }));
  const client = { storage: { from } } as unknown as SupabaseClient;
  const resolve = (row = generation, outputs = [{ url: original, generationId: 'gen', kind: 'video' as const }]) => resolveTemplateRunMedia({ client, ownerId: 'owner', runId: 'run', generations: [row], outputs });
  return { sign, from, resolve, client };
}

describe('owned template playback delivery', () => {
  it('signs step, approval and final output once per bucket, routing renditions through the media route', async () => {
    const { client, sign, from } = fixture();
    const results = await resolveTemplateRunMedia({ client, ownerId: 'owner', runId: 'run', generations: [generation],
      outputs: ['gen', null, 'gen'].map(generationId => ({ url: original, generationId, kind: 'video' })) });
    expect(results).toEqual(Array(3).fill({ url: 'https://signed.test/owner/clip.mp4', renditionUrl: '/api/media?bucket=generated_videos&path=owner%2Fplayback%2Fgen%2Fclip.mp4', previewUrl: 'https://signed.test/owner/clip.preview.hash.webp' }));
    expect(from).toHaveBeenCalledTimes(1);
    // The rendition is addressed through the authenticated media route, so it is never signed here.
    expect(sign).toHaveBeenCalledWith(['owner/clip.mp4', 'owner/clip.preview.hash.webp'], 3600);
  });

  it.each([
    { user_id: 'other' }, { template_run_id: 'other' }, { id: 'other' }, { output_url: 'generated_videos/owner/new.mp4' },
  ])('does not attach derivatives from another owner, run, generation or output: %j', async (patch) => {
    const { resolve } = fixture();
    expect(await resolve({ ...generation, ...patch })).toEqual([{ url: 'https://signed.test/owner/clip.mp4' }]);
  });

  it.each([
    { playback_rendition_status: 'processing' }, { playback_rendition_source: 'generated_videos/owner/old.mp4' },
    { playback_rendition_path: 'generated_videos/other/playback/gen/clip.mp4' },
    { playback_rendition_path: 'generated_videos/owner/playback/another/clip.mp4' },
  ])('falls back to the original when the playback file is ineligible: %j', async (patch) => {
    const { resolve, sign } = fixture();
    expect((await resolve({ ...generation, ...patch }))[0]).not.toHaveProperty('renditionUrl');
    expect(sign.mock.calls[0][0]).toEqual(['owner/clip.mp4', 'owner/clip.preview.hash.webp']);
  });

  it('does not attach a video rendition to an image', async () => {
    const { client } = fixture();
    const [result] = await resolveTemplateRunMedia({ client, ownerId: 'owner', runId: 'run', generations: [generation], outputs: [{ url: original, generationId: 'gen', kind: 'image' }] });
    expect(result).not.toHaveProperty('renditionUrl');
  });

  it('preserves fixed input resolution and safe external originals', async () => {
    const { client } = fixture();
    const result = await resolveTemplateRunMedia({ client, ownerId: 'owner', runId: 'run', generations: [], outputs: [
      { url: 'template_inputs/owner/fixed.jpg', generationId: null, kind: 'image' },
      { url: 'https://provider.test/image.jpg', generationId: null, kind: 'image' },
    ] });
    expect(result).toEqual([{ url: 'https://single.test/template_inputs/owner/fixed.jpg' }, { url: 'https://provider.test/image.jpg' }]);
  });
});
