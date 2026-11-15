import { describe, expect, it } from 'vitest';

import { creatorLinkModel, creatorLinkModelStep } from '../lib/creator-link-model-view-model';

// A creator opened on a model (`/create/video?model=seedance-2`, search's row
// for a catalog model nobody has posted with yet, 2026-11-15): which model the
// link names, and what the creator does with it as its drafts and catalog arrive.

describe('the model a creator link names', () => {
  it('is the link\'s `model`, trimmed', () => {
    expect(creatorLinkModel({ model: ' seedance-2 ' })).toBe('seedance-2');
    expect(creatorLinkModel({ model: ['kling-2.6', 'other'] })).toBe('kling-2.6');
  });

  it('is none for a link without one, and none for a remix or a guided first creation, which choose their own', () => {
    expect(creatorLinkModel({ model: undefined })).toBeNull();
    expect(creatorLinkModel({ model: '   ' })).toBeNull();
    expect(creatorLinkModel({ model: 'seedance-2', remix: true })).toBeNull();
    expect(creatorLinkModel({ model: 'seedance-2', guided: true })).toBeNull();
  });

  it('is none for text no catalog id could be', () => {
    expect(creatorLinkModel({ model: 'x'.repeat(200) })).toBeNull();
    expect(creatorLinkModel({ model: 'two words' })).toBeNull();
  });
});

describe('what the creator does with it', () => {
  const ready = { ready: true, loaded: true, missing: false, usable: true };

  it('waits until its drafts are read and the catalog confirmed, so neither puts another model over it', () => {
    expect(creatorLinkModelStep({ ...ready, ready: false })).toBe('wait');
    expect(creatorLinkModelStep({ ...ready, loaded: false })).toBe('wait');
  });

  it('chooses it as the picker would once it is in, for its own creator only', () => {
    expect(creatorLinkModelStep(ready)).toBe('pick');
    // Another kind's model, or one the app does not offer: the draft keeps its own.
    expect(creatorLinkModelStep({ ...ready, usable: false })).toBe('drop');
  });

  it('drops a model the catalog says it does not have', () => {
    expect(creatorLinkModelStep({ ...ready, loaded: false, missing: true })).toBe('drop');
  });
});
