import { describe, expect, it } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { ApiError } from '../lib/api-client';
import { createPostCreateKey, postCreateKeyAfterFailure } from '../lib/post-create-key';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const idempotency = mobileApiContract.endpoints.createPost.idempotency;

// Audit 2026-11-27, finding 4: one key per composed post, kept across a failed attempt, so the
// server answers a retry with the post the first attempt made instead of making a second.
describe('the key a composed post is created under', () => {
  it('is a version 4 UUID, which the server takes as the new post\'s id', () => {
    expect(createPostCreateKey()).toMatch(UUID);
    expect(createPostCreateKey(() => 'not-a-uuid')).toMatch(UUID);
    expect(createPostCreateKey()).not.toBe(createPostCreateKey());
  });

  it('survives a failure the server may have acted on, and one it refused', () => {
    const key = createPostCreateKey();
    const lost = new ApiError('Network request failed', 0, { sent: true });
    const failed = new ApiError('Failed to create post.', 500, { error: 'Failed to create post.' });
    const saving = new ApiError(
      idempotency.errors.inProgress.response.error,
      idempotency.errors.inProgress.status,
      idempotency.errors.inProgress.response,
      undefined,
      idempotency.errors.inProgress.response.code,
    );

    for (const error of [lost, failed, saving, new Error('offline')]) {
      expect(postCreateKeyAfterFailure(key, error)).toBe(key);
    }
  });

  it('is replaced when the server says it cannot be used again', () => {
    const key = createPostCreateKey();
    const conflict = new ApiError(
      idempotency.errors.conflict.response.error,
      idempotency.errors.conflict.status,
      idempotency.errors.conflict.response,
      undefined,
      idempotency.errors.conflict.response.code,
    );

    const next = postCreateKeyAfterFailure(key, conflict);
    expect(next).toMatch(UUID);
    expect(next).not.toBe(key);
  });
});
