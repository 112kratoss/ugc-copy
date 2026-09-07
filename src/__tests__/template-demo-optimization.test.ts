import { beforeEach, describe, expect, it, vi } from 'vitest';
import { copyOwnedTemplateAssetToVersion } from '@/lib/media-template-service';
import { createVideoRenditionFromFile, withVideoInputFile } from '@/lib/video-rendition';

vi.mock('@/lib/video-rendition', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/video-rendition')>(),
  createVideoRenditionFromFile: vi.fn(),
  withVideoInputFile: vi.fn(async (blob: Blob, work: (path: string, size: number) => unknown) => work('input', blob.size)),
}));
vi.mock('@/lib/backend-logger', () => ({ logBackendError: vi.fn() }));

const original = new Blob([new Uint8Array(1000)], { type: 'video/quicktime' });
const bytes = Buffer.from([0, 255, 128, 1]);
function fixture(blob = original, sourceStoragePath = 'generated_videos/owner/output.mov', destinationSegment = 'demo') {
  const upload = vi.fn(async () => ({ error: null }));
  const download = vi.fn(async () => ({ data: blob, error: null }));
  const client = { storage: { from: () => ({ download, upload }) } } as never;
  return { upload, download, run: () => copyOwnedTemplateAssetToVersion({ client, userId: 'owner', templateId: 'template', versionId: 'version', sourceStoragePath, kind: 'video', destinationSegment }) };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createVideoRenditionFromFile).mockResolvedValue({ buffer: bytes, bytes: bytes.length, width: 320, height: 240, durationSeconds: 2 });
});

describe('published demo optimization', () => {
  it('stores a smaller MP4 with exact bytes, leaving the original source untouched', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.destination).toBe('template/version/demo/playback.mp4');
    expect(result.blob.type).toBe('video/mp4');
    expect(Buffer.from(await result.blob.arrayBuffer())).toEqual(bytes);
    expect(f.upload).toHaveBeenCalledWith(result.destination, result.blob, { contentType: 'video/mp4', upsert: false });
    expect(f.download).toHaveBeenCalledOnce();
  });
  it('passes a deadline to the encoder', async () => {
    await fixture().run();
    expect(createVideoRenditionFromFile).toHaveBeenCalledWith('input', original.size, { signal: expect.any(AbortSignal) });
  });
  it('still publishes the original demo when encoding fails or is not worthwhile', async () => {
    vi.mocked(createVideoRenditionFromFile).mockRejectedValue(new Error('not smaller / encode failed'));
    const result = await fixture().run();
    expect(result.blob).toBe(original);
    expect(result.destination).toBe('template/version/demo/output.mov');
  });
  it('does not encode fixed workflow inputs', async () => {
    const result = await fixture(original, undefined, 'fixed-input').run();
    expect(result.blob).toBe(original);
    expect(withVideoInputFile).not.toHaveBeenCalled();
  });
  it('bounds demo encoding to 64 MiB inputs', async () => {
    const large = new Blob([new Uint8Array(64 * 1024 * 1024 + 1)], { type: 'video/mp4' });
    const result = await fixture(large).run();
    expect(result.blob).toBe(large);
    expect(withVideoInputFile).not.toHaveBeenCalled();
  });
  it('rejects foreign media before downloading or encoding it', async () => {
    const f = fixture(original, 'generated_videos/other/output.mov');
    await expect(f.run()).rejects.toMatchObject({ code: 'TEMPLATE_ASSET_NOT_OWNED' });
    expect(f.download).not.toHaveBeenCalled();
    expect(withVideoInputFile).not.toHaveBeenCalled();
  });
});
