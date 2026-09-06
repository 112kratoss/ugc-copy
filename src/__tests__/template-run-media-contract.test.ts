import { describe, expect, it } from 'vitest';
import contract from '../../contracts/template-run-media-v1.json';
import { normalizeTemplateRun, normalizeTemplate } from '@/app/components/templates/api';

describe('template media wire contract', () => {
  it('preserves separate originals, playback and poster URLs for steps and final results', () => {
    const run = normalizeTemplateRun(contract.response);
    expect(run.result).toEqual(contract.response.run.result);
    expect(run.steps[0]).toMatchObject(contract.response.run.steps[0]);
  });
  it('accepts older responses without derivatives', () => {
    const run = normalizeTemplateRun({ run: { id: 'old', steps: [{ id: 'step', outputUrl: '/old.mp4', mediaKind: 'video' }], result: { kind: 'video', url: '/old.mp4' } } });
    expect(run.result).not.toHaveProperty('renditionUrl');
    expect(run.steps[0]).not.toHaveProperty('previewUrl');
  });
});

it('keeps unavailable catalog media null instead of reconstructing storage paths', () => {
  expect(normalizeTemplate(contract.unavailableDemoResponse)).toMatchObject({ videoUrl: null, thumbnailUrl: null });
});
