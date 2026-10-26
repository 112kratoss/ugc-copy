import { describe, expect, it } from 'vitest';

import { creatorParameterSummary } from '@/lib/creator-parameter-summary';
import type { CatalogChoiceControl } from '@/lib/generation-model-catalog';
import { createDefaultCreationDraft, type MediaDraft } from '@/lib/media-creation-view-model';

/**
 * The creator bar's summary reads the draft and its model into the words the web creators use
 * too; the words themselves are held by src/__tests__/creator-settings-summary.test.ts.
 */

const modeControl: CatalogChoiceControl = {
  key: 'mode',
  label: 'Quality mode',
  type: 'choice',
  presentation: 'chips',
  defaultValue: 'std',
  options: [
    { value: 'std', label: 'Standard' },
    { value: 'pro', label: 'Pro 1080p' },
  ],
};

function clip(durationSeconds: number | null): MediaDraft {
  return { id: 'clip-1', kind: 'video', url: 'https://cdn.example.com/moves.mp4', fileName: 'moves.mp4', displayName: 'moves', durationSeconds };
}

describe('the video bar summary', () => {
  it('reads the draft\'s resolution, ratio and length before its model is in', () => {
    expect(creatorParameterSummary(createDefaultCreationDraft('video'), null)).toBe('720P · 9:16 · 5s');
  });

  it('reads the resolution the chosen mode\'s label names over the resolution setting', () => {
    const model = { controls: [modeControl] };
    expect(creatorParameterSummary({ ...createDefaultCreationDraft('video'), mode: 'pro' }, model)).toBe('1080P · 9:16 · 5s');
    expect(creatorParameterSummary({ ...createDefaultCreationDraft('video'), mode: 'std' }, model)).toBe('720P · 9:16 · 5s');
  });

  it('reads the mode\'s own value where the model has no mode control', () => {
    const draft = { ...createDefaultCreationDraft('video'), mode: '1080p', aspectRatio: '16:9' };
    expect(creatorParameterSummary(draft, { controls: [] })).toBe('1080P · 16:9 · 5s');
  });

  it('gives a multi-shot run\'s length as its shots together, as the request sends them', () => {
    const draft = {
      ...createDefaultCreationDraft('video'),
      isMultiShot: true,
      multiPrompts: [{ id: 'shot-1', prompt: '', duration: 3 }, { id: 'shot-2', prompt: '', duration: 4.6 }],
    };
    expect(creatorParameterSummary(draft, null)).toBe('720P · 9:16 · 8s');
  });
});

describe('the motion bar summary', () => {
  it('reads the quality and the clip\'s length, rounded up', () => {
    const draft = { ...createDefaultCreationDraft('motion'), mode: '1080p' as const, referenceVideo: clip(7.2) };
    expect(creatorParameterSummary(draft, null)).toBe('1080P · 8s');
  });

  it('takes the draft\'s length for a clip whose own is unknown', () => {
    const draft = { ...createDefaultCreationDraft('motion'), referenceVideo: clip(null), duration: 10 };
    expect(creatorParameterSummary(draft, null)).toBe('720P · 10s');
  });

  it('asks for the motion while there is no clip, whatever length the draft holds', () => {
    const draft = { ...createDefaultCreationDraft('motion'), duration: 10 };
    expect(creatorParameterSummary(draft, null)).toBe('720P · Add motion');
  });
});
