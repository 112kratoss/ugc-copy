import { describe, expect, it } from 'vitest';

import {
  isSignedMediaUrlExpiring,
  preserveStableSignedUrl,
  preserveStableTemplateRunMedia,
  readSignedMediaUrlExpiryMs,
} from '@/lib/template-run-stable-media';

const NOW_MS = Date.parse('2026-10-14T10:00:00.000Z');
const MINUTE_MS = 60_000;

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A Storage address signed the way Supabase signs one, with `exp` in seconds. */
function signedUrl(path: string, expiresInMs: number, nonce = 'a'): string {
  const token = [
    base64Url({ alg: 'HS256', typ: 'JWT' }),
    base64Url({ url: path, iat: Math.floor(NOW_MS / 1000), exp: Math.floor((NOW_MS + expiresInMs) / 1000), nonce }),
    'signature',
  ].join('.');
  return `https://project.supabase.co/storage/v1/object/sign/${path}?token=${token}`;
}

function run(overrides: {
  id?: string;
  stepUrl?: string | null;
  stepPreviewUrl?: string;
  resultUrl?: string;
  resultPreviewUrl?: string;
  renditionUrl?: string;
  stepId?: string;
} = {}) {
  return {
    id: overrides.id ?? 'run-1',
    status: 'processing',
    steps: [{
      id: overrides.stepId ?? 'step-1',
      label: 'Opening image',
      outputUrl: overrides.stepUrl === undefined ? signedUrl('generated_images/u/step.png', 60 * MINUTE_MS) : overrides.stepUrl,
      ...(overrides.stepPreviewUrl ? { previewUrl: overrides.stepPreviewUrl } : {}),
    }],
    result: overrides.resultUrl ? {
      generationId: 'generation-1',
      kind: 'video' as const,
      url: overrides.resultUrl,
      ...(overrides.renditionUrl ? { renditionUrl: overrides.renditionUrl } : {}),
      ...(overrides.resultPreviewUrl ? { previewUrl: overrides.resultPreviewUrl } : {}),
      linkedPost: null,
    } : null,
  };
}

describe('reading a signed media address', () => {
  it('reads when the token stops working, and nothing from an address that is not signed', () => {
    expect(readSignedMediaUrlExpiryMs(signedUrl('generated_images/u/a.png', 10 * MINUTE_MS))).toBe(NOW_MS + 10 * MINUTE_MS);
    expect(readSignedMediaUrlExpiryMs('/api/media?bucket=generated_videos&path=u%2Fa.mp4')).toBeNull();
    expect(readSignedMediaUrlExpiryMs('https://project.supabase.co/storage/v1/object/sign/generated_images/u/a.png')).toBeNull();
    expect(readSignedMediaUrlExpiryMs('https://project.supabase.co/storage/v1/object/sign/generated_images/u/a.png?token=not-a-jwt')).toBeNull();
  });

  it('calls an address expiring within five minutes of its end, and never one it cannot read', () => {
    expect(isSignedMediaUrlExpiring(signedUrl('generated_images/u/a.png', 4 * MINUTE_MS), NOW_MS)).toBe(true);
    expect(isSignedMediaUrlExpiring(signedUrl('generated_images/u/a.png', -MINUTE_MS), NOW_MS)).toBe(true);
    expect(isSignedMediaUrlExpiring(signedUrl('generated_images/u/a.png', 6 * MINUTE_MS), NOW_MS)).toBe(false);
    expect(isSignedMediaUrlExpiring('/result.png', NOW_MS)).toBe(false);
    expect(isSignedMediaUrlExpiring(null, NOW_MS)).toBe(false);
  });
});

describe('keeping a signed address across reads', () => {
  it('keeps the address it had for the same file while it has more than five minutes left', () => {
    const previous = signedUrl('generated_images/u/a.png', 50 * MINUTE_MS, 'first');
    const resigned = signedUrl('generated_images/u/a.png', 60 * MINUTE_MS, 'second');
    expect(resigned).not.toBe(previous);
    expect(preserveStableSignedUrl(previous, resigned, NOW_MS)).toBe(previous);
  });

  it('takes the new address once the one it had is within five minutes of its end', () => {
    const previous = signedUrl('generated_images/u/a.png', 4 * MINUTE_MS, 'first');
    const resigned = signedUrl('generated_images/u/a.png', 60 * MINUTE_MS, 'second');
    expect(preserveStableSignedUrl(previous, resigned, NOW_MS)).toBe(resigned);
  });

  it('takes the new address of a different file, or when there was none before', () => {
    const previous = signedUrl('generated_images/u/a.png', 50 * MINUTE_MS);
    const other = signedUrl('generated_images/u/b.png', 60 * MINUTE_MS);
    expect(preserveStableSignedUrl(previous, other, NOW_MS)).toBe(other);
    expect(preserveStableSignedUrl(null, other, NOW_MS)).toBe(other);
    expect(preserveStableSignedUrl(undefined, other, NOW_MS)).toBe(other);
  });

  it('takes the new address when the old one has no readable expiry, and keeps a missing one missing', () => {
    expect(preserveStableSignedUrl('/a.png?v=1', '/a.png?v=2', NOW_MS)).toBe('/a.png?v=2');
    expect(preserveStableSignedUrl(signedUrl('generated_images/u/a.png', 50 * MINUTE_MS), null, NOW_MS)).toBeNull();
  });
});

describe('preserveStableTemplateRunMedia', () => {
  it('keeps each step and the result on the addresses already shown when they are re-signed', () => {
    const previous = run({
      stepPreviewUrl: signedUrl('generated_images/u/step-preview.webp', 50 * MINUTE_MS, 'first'),
      resultUrl: signedUrl('generated_videos/u/result.mp4', 50 * MINUTE_MS, 'first'),
      resultPreviewUrl: signedUrl('generated_images/u/result-poster.webp', 50 * MINUTE_MS, 'first'),
      renditionUrl: '/api/media?bucket=generated_videos&path=u%2Fplayback%2Fresult.mp4',
    });
    const next = run({
      stepUrl: signedUrl('generated_images/u/step.png', 60 * MINUTE_MS, 'second'),
      stepPreviewUrl: signedUrl('generated_images/u/step-preview.webp', 60 * MINUTE_MS, 'second'),
      resultUrl: signedUrl('generated_videos/u/result.mp4', 60 * MINUTE_MS, 'second'),
      resultPreviewUrl: signedUrl('generated_images/u/result-poster.webp', 60 * MINUTE_MS, 'second'),
      renditionUrl: '/api/media?bucket=generated_videos&path=u%2Fplayback%2Fresult.mp4',
    });
    next.status = 'succeeded';

    const stable = preserveStableTemplateRunMedia(previous, next, NOW_MS);

    expect(stable.steps[0].outputUrl).toBe(previous.steps[0].outputUrl);
    expect(stable.steps[0].previewUrl).toBe(previous.steps[0].previewUrl);
    expect(stable.result?.url).toBe(previous.result?.url);
    expect(stable.result?.previewUrl).toBe(previous.result?.previewUrl);
    expect(stable.result?.renditionUrl).toBe(next.result?.renditionUrl);
    // Everything else is the new read's.
    expect(stable.status).toBe('succeeded');
    expect(stable.steps[0].label).toBe('Opening image');
    expect(stable.result).toMatchObject({ generationId: 'generation-1', kind: 'video', linkedPost: null });
  });

  it('takes the new addresses once the old ones are within five minutes of their end', () => {
    const previous = run({
      stepUrl: signedUrl('generated_images/u/step.png', 4 * MINUTE_MS, 'first'),
      resultUrl: signedUrl('generated_videos/u/result.mp4', 4 * MINUTE_MS, 'first'),
    });
    const next = run({
      stepUrl: signedUrl('generated_images/u/step.png', 60 * MINUTE_MS, 'second'),
      resultUrl: signedUrl('generated_videos/u/result.mp4', 60 * MINUTE_MS, 'second'),
    });

    const stable = preserveStableTemplateRunMedia(previous, next, NOW_MS);

    expect(stable.steps[0].outputUrl).toBe(next.steps[0].outputUrl);
    expect(stable.result?.url).toBe(next.result?.url);
  });

  it('takes the new read as it is for another step, another file, another run or no earlier read', () => {
    const previous = run({ resultUrl: signedUrl('generated_videos/u/result.mp4', 50 * MINUTE_MS, 'first') });
    const retried = run({ stepId: 'step-1-attempt-2', stepUrl: signedUrl('generated_images/u/step.png', 60 * MINUTE_MS, 'second') });
    const otherFile = run({ stepUrl: signedUrl('generated_images/u/step-v2.png', 60 * MINUTE_MS, 'second') });
    const otherRun = run({ id: 'run-2', stepUrl: signedUrl('generated_images/u/step.png', 60 * MINUTE_MS, 'second') });
    const resultGone = run({ stepUrl: signedUrl('generated_images/u/step.png', 60 * MINUTE_MS, 'second') });

    expect(preserveStableTemplateRunMedia(previous, retried, NOW_MS).steps[0].outputUrl).toBe(retried.steps[0].outputUrl);
    expect(preserveStableTemplateRunMedia(previous, otherFile, NOW_MS).steps[0].outputUrl).toBe(otherFile.steps[0].outputUrl);
    expect(preserveStableTemplateRunMedia(previous, otherRun, NOW_MS)).toBe(otherRun);
    expect(preserveStableTemplateRunMedia(null, otherRun, NOW_MS)).toBe(otherRun);
    expect(preserveStableTemplateRunMedia(previous, resultGone, NOW_MS).result).toBeNull();
  });

  it('adds no media field the new read left out', () => {
    const previous = run({
      stepPreviewUrl: signedUrl('generated_images/u/step-preview.webp', 50 * MINUTE_MS),
      resultUrl: signedUrl('generated_videos/u/result.mp4', 50 * MINUTE_MS),
      renditionUrl: '/api/media?bucket=generated_videos&path=u%2Fplayback%2Fresult.mp4',
    });
    const next = run({ resultUrl: signedUrl('generated_videos/u/result.mp4', 60 * MINUTE_MS, 'second') });

    const stable = preserveStableTemplateRunMedia(previous, next, NOW_MS);

    expect(stable.steps[0]).not.toHaveProperty('previewUrl');
    expect(stable.result).not.toHaveProperty('renditionUrl');
    expect(stable.result).not.toHaveProperty('previewUrl');
  });
});
