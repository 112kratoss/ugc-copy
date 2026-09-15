import { describe, expect, it } from 'vitest';
import { createDefaultCreationDraft, type VideoCreationDraft } from '../lib/media-creation-view-model';
import { needsRemixReferenceRecovery, recoverRemixReferences } from '../lib/remix-draft-recovery';
const reference = { id: 'girl', kind: 'image' as const, url: 'https://example.com/girl.jpg', fileName: 'girl.jpg', displayName: 'Girl', handle: '@girl' };
function draft(overrides: Partial<VideoCreationDraft> = {}): VideoCreationDraft {
  return { ...createDefaultCreationDraft('video'), model: 'seedance-2', prompt: 'My edited scene with @girl', ...overrides };
}
describe('saved remix reference recovery', () => {
  it('adds only source images still mentioned while preserving every other saved field', () => {
    const current = draft({ aspectRatio: '9:16', duration: 8 });
    const restored = draft({ aspectRatio: '16:9', duration: 4, references: [reference, { ...reference, id: 'other', handle: '@other' }] });
    expect(needsRemixReferenceRecovery(current)).toBe(true);
    expect(recoverRemixReferences(current, restored)).toEqual({ ...current, references: [reference] });
  });
  it('does not undo removal, replacement inputs, or a model change during loading', () => {
    const restored = draft({ references: [reference] });
    for (const current of [draft({ prompt: 'My edited scene' }), draft({ references: [{ ...reference, handle: '@replacement' }] }), draft({ startFrame: reference }), draft({ model: 'different-model' })]) {
      expect(recoverRemixReferences(current, restored)).toBe(current);
    }
  });
  it('does not invent references for an unrelated unknown mention or an unavailable source', () => {
    const current = draft({ prompt: '@new_subject' });
    expect(recoverRemixReferences(current, draft({ references: [reference] }))).toBe(current);
    expect(recoverRemixReferences(draft(), draft())).toEqual(draft());
  });
});
