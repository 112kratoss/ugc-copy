import { describe, expect, it } from 'vitest';

import {
  buildIntentSeedRow,
  categorizeBacklogObject,
  getSeedConsumer,
  inferUploadIntentKind,
  isUserScopedStagedPath,
  type BacklogObject,
} from '@/lib/media-upload-backlog-seed';

function stagedObject(overrides: Partial<BacklogObject> = {}): BacklogObject {
  return {
    storagePath: 'user-1/abc-ref.png',
    sizeBytes: 2048,
    mimeType: 'image/png',
    createdAt: '2026-03-27T09:00:00.000Z',
    ...overrides,
  };
}

const noReferences = { legacyReferenced: new Set<string>(), durableCopied: new Set<string>() };

describe('inferUploadIntentKind', () => {
  it('prefers the reported mime type', () => {
    expect(inferUploadIntentKind('video/mp4', 'user-1/a.bin')).toBe('video');
    expect(inferUploadIntentKind('audio/mpeg', 'user-1/a.bin')).toBe('audio');
    expect(inferUploadIntentKind('image/webp', 'user-1/a.bin')).toBe('image');
  });

  it('falls back to the extension when storage reports no mime type', () => {
    expect(inferUploadIntentKind(null, 'user-1/clip.mov')).toBe('video');
    expect(inferUploadIntentKind(null, 'user-1/voice.wav')).toBe('audio');
    expect(inferUploadIntentKind(null, 'user-1/shot.png')).toBe('image');
  });

  it('defaults to image so the kind check constraint always passes', () => {
    expect(inferUploadIntentKind(null, 'user-1/mystery')).toBe('image');
  });
});

describe('isUserScopedStagedPath', () => {
  it('accepts the current {userId}/{uploadId}-{name} layout', () => {
    expect(isUserScopedStagedPath('28677503-bfbe-4e99-9105-b8f0c7e0e507/abc-ref.png')).toBe(true);
  });

  it('rejects paths from the retired root-level scheme', () => {
    // These really exist in production -- `images/...` and `videos/...` written
    // before uploads were scoped per user. Seeding them threw a uuid syntax
    // error because the first path segment was the filename, so the whole
    // backfill aborted rather than skipping 60 objects.
    expect(isUserScopedStagedPath('images/1770464299435-photo.jpg')).toBe(false);
    expect(isUserScopedStagedPath('videos/1770464299437-clip.mp4')).toBe(false);
    expect(isUserScopedStagedPath('2lda807m63j.mp4')).toBe(false);
    expect(isUserScopedStagedPath('not-a-uuid/file.png')).toBe(false);
  });
});

describe('categorizeBacklogObject', () => {
  it('marks an object whose bytes were copied into generation_inputs as redundant', () => {
    const object = categorizeBacklogObject(stagedObject(), {
      legacyReferenced: new Set(),
      durableCopied: new Set(['user-1/abc-ref.png']),
    });
    expect(object.category).toBe('durable_copy_exists');
  });

  it('marks an object a generation still reads as a legacy reference', () => {
    const object = categorizeBacklogObject(stagedObject(), {
      legacyReferenced: new Set(['user-1/abc-ref.png']),
      durableCopied: new Set(),
    });
    expect(object.category).toBe('legacy_generation_reference');
  });

  it('treats a legacy reference as load-bearing even when a durable copy also exists', () => {
    // A generation reading the staging file directly is load-bearing regardless
    // of what else may have copied those bytes elsewhere.
    const object = categorizeBacklogObject(stagedObject(), {
      legacyReferenced: new Set(['user-1/abc-ref.png']),
      durableCopied: new Set(['user-1/abc-ref.png']),
    });
    expect(object.category).toBe('legacy_generation_reference');
  });

  it('treats everything else as unreferenced', () => {
    expect(categorizeBacklogObject(stagedObject(), noReferences).category).toBe('unreferenced');
  });
});

describe('getSeedConsumer', () => {
  it('only marks the redundant category consumed', () => {
    // Consumed rows are collectable by the already-live half of the sweep, so
    // anything still possibly in use must be seeded unconsumed and stay behind
    // the abandoned-reclaim gate.
    expect(getSeedConsumer('durable_copy_exists')).toBe('generation_input');
    expect(getSeedConsumer('legacy_generation_reference')).toBeNull();
    expect(getSeedConsumer('unreferenced')).toBeNull();
  });
});

describe('buildIntentSeedRow', () => {
  it('dates the row from the object so the reclaim window measures real age', () => {
    const row = buildIntentSeedRow(categorizeBacklogObject(stagedObject(), noReferences));
    expect(row.created_at).toBe('2026-03-27T09:00:00.000Z');
    expect(row.storage_cleared_at).toBeNull();
  });

  it('derives the owner from the staged path layout', () => {
    const row = buildIntentSeedRow(categorizeBacklogObject(stagedObject(), noReferences));
    expect(row.user_id).toBe('user-1');
  });

  it('writes consumed_at and consumed_by together or not at all', () => {
    // The table's pair constraint rejects one without the other.
    const consumed = buildIntentSeedRow(categorizeBacklogObject(stagedObject(), {
      legacyReferenced: new Set(),
      durableCopied: new Set(['user-1/abc-ref.png']),
    }));
    expect(consumed.consumed_by).toBe('generation_input');
    expect(consumed.consumed_at).toBe(consumed.created_at);

    const unconsumed = buildIntentSeedRow(categorizeBacklogObject(stagedObject(), noReferences));
    expect(unconsumed.consumed_by).toBeNull();
    expect(unconsumed.consumed_at).toBeNull();
  });

  it('carries the declared size and content type through for reporting', () => {
    const row = buildIntentSeedRow(categorizeBacklogObject(stagedObject(), noReferences));
    expect(row.declared_bytes).toBe(2048);
    expect(row.content_type).toBe('image/png');
    expect(row.kind).toBe('image');
  });
});
