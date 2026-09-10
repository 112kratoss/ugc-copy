import { describe, expect, it, vi } from 'vitest';
import { createTemplateDemoPosterAsset, getMediaTemplate } from '@/lib/media-template-service';
const { bytes } = vi.hoisted(() => ({ bytes: Buffer.from([82, 73, 70, 70, 255, 128, 0, 1]) }));
vi.mock('@/lib/video-poster', () => ({ createVideoPosterBuffer: vi.fn(async () => bytes) }));

it('uploads exact poster bytes as a Blob instead of the lossy raw body path', async () => {
  const upload = vi.fn(async () => ({ error: null }));
  await createTemplateDemoPosterAsset({ client: { storage: { from: () => ({ upload }) } } as never, templateId: 'template', versionId: 'version', demoBlob: new Blob(['video']) });
  const body = (upload.mock.calls[0] as unknown as [string, Blob])[1];
  expect(body).toBeInstanceOf(Blob);
  expect(body.type).toBe('image/webp');
  expect(Buffer.from(await body.arrayBuffer())).toEqual(bytes);
});

describe('catalog media signing failures', () => {
  it.each(['signing failure', 'wrong version'])('does not expose a raw storage path after %s', async (reason) => {
    const row = { id: 'template', slug: 'demo', name: 'Demo', status: 'active', is_active: true, creator_user_id: 'owner', active_version_id: 'version', output_kind: 'video', video_url: `template_assets/template/${reason === 'wrong version' ? 'old-version' : 'version'}/demo/video.mp4`, thumbnail_url: 'template_assets/template/version/demo/poster.webp' };
    const client = { from: () => { const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: row, error: null }), in: async () => ({ data: [], error: null }) }; return query; }, storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: 'Unavailable' } }) }) } } as never;
    const result = await getMediaTemplate(client, 'demo', null);
    expect(result.videoUrl).toBeNull();
    expect(result.thumbnailUrl).toBeNull();
  });
});
