import { describe, expect, it } from 'vitest';

import {
  classifyPreviewCandidate,
  drawIntegritySample,
} from '@/lib/media-integrity-audit';

const candidate = (overrides: Partial<Parameters<typeof classifyPreviewCandidate>[0]> = {}) => ({
  sourceUnavailable: false,
  path: 'showcase_media/posts/post-1/0/photo.preview.abc.webp',
  category: 'image',
  hasSource: true,
  ...overrides,
});

describe('classifyPreviewCandidate', () => {
  it('counts a record whose only source is gone instead of failing it', () => {
    // Three such records kept this audit red permanently: they have no preview
    // and never will, and the product already says so in the UI.
    expect(classifyPreviewCandidate(candidate({ sourceUnavailable: true, path: null })))
      .toEqual({ kind: 'source_unavailable' });
  });

  it('takes the unavailable marker over everything else, preview or not', () => {
    expect(classifyPreviewCandidate(candidate({ sourceUnavailable: true })))
      .toEqual({ kind: 'source_unavailable' });
  });

  it('still reports media that owes a preview and has a source to build one from', () => {
    expect(classifyPreviewCandidate(candidate({ path: null })))
      .toEqual({ kind: 'finding', issue: 'missing_preview' });
  });

  it('distinguishes a row with neither a source nor a preview', () => {
    expect(classifyPreviewCandidate(candidate({ path: null, hasSource: false })))
      .toEqual({ kind: 'finding', issue: 'missing_source_and_preview' });
  });

  it('expects nothing visual of text or audio', () => {
    expect(classifyPreviewCandidate(candidate({ path: null, category: 'text' })))
      .toEqual({ kind: 'not_applicable' });
    expect(classifyPreviewCandidate(candidate({ path: null, category: 'audio' })))
      .toEqual({ kind: 'not_applicable' });
  });

  it('carries the path forward for a row worth downloading', () => {
    expect(classifyPreviewCandidate(candidate()))
      .toEqual({ kind: 'checkable', path: 'showcase_media/posts/post-1/0/photo.preview.abc.webp' });
  });
});

describe('drawIntegritySample', () => {
  it('spreads across the corpus rather than re-reading its oldest corner', () => {
    const rows = Array.from({ length: 100 }, (_unused, index) => index);
    const sample = drawIntegritySample(rows, 5);

    expect(sample).toEqual([0, 20, 40, 60, 80]);
  });

  it('returns everything when the corpus is smaller than the sample', () => {
    expect(drawIntegritySample([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('copies rather than aliasing the caller’s array', () => {
    const rows = [1, 2, 3];
    expect(drawIntegritySample(rows, 10)).not.toBe(rows);
  });

  it('draws nothing for a non-positive size', () => {
    expect(drawIntegritySample([1, 2, 3], 0)).toEqual([]);
  });
});
