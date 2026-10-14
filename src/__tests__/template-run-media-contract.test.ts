import { describe, expect, it } from 'vitest';
import contract from '../../contracts/template-run-media-v1.json';
import { normalizeTemplateRun, normalizeTemplate } from '@/components/templates/api';

describe('template media wire contract', () => {
  it('preserves separate originals, playback and poster URLs for steps and final results', () => {
    const run = normalizeTemplateRun(contract.response);
    expect(run.result).toEqual(contract.response.run.result);
    expect(run.steps[0]).toMatchObject(contract.response.run.steps[0]);
  });
  it('accepts older responses without derivatives', () => {
    const run = normalizeTemplateRun({ run: { id: 'old', steps: [{ id: 'step', outputUrl: '/old.mp4', mediaKind: 'video' }], result: { kind: 'video', url: '/old.mp4' } } });
    expect(run.result).not.toHaveProperty('renditionUrl');
    expect(run.result).not.toHaveProperty('linkedPost');
    expect(run.steps[0]).not.toHaveProperty('previewUrl');
  });
  it('carries the post made from the result, and counts a post of unknown visibility as private', () => {
    const withPost = (linkedPost: unknown) => normalizeTemplateRun({
      run: { ...contract.response.run, result: { ...contract.response.run.result, linkedPost } },
    }).result?.linkedPost;
    expect(withPost({ id: 'post-1', visibility: 'unlisted' })).toEqual({ id: 'post-1', visibility: 'unlisted' });
    expect(withPost({ id: 'post-1', visibility: 'archived' })).toEqual({ id: 'post-1', visibility: 'private' });
    expect(withPost({ visibility: 'public' })).toBeNull();
    expect(withPost(null)).toBeNull();
  });
});

it('keeps unavailable catalog media null instead of reconstructing storage paths', () => {
  expect(normalizeTemplate(contract.unavailableDemoResponse)).toMatchObject({ videoUrl: null, thumbnailUrl: null });
});
