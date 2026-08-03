import { describe, expect, it, vi } from 'vitest';

import {
  getConfirmedRemovedPaths,
  markMediaUploadIntentsCleared,
  markMediaUploadIntentsConsumed,
  normalizeUploadIntentPath,
  recordMediaUploadIntent,
} from '@/lib/media-upload-intents';

function updateClientDouble(error: { message?: string } | null = null) {
  const filters: Array<{ method: 'in' | 'is'; column: string; value: unknown }> = [];
  const values: Record<string, unknown>[] = [];

  // Delegating to a real promise keeps `then` structurally identical to
  // PromiseLike, which the production filter type requires.
  const settled = Promise.resolve({ error });
  const chain = {
    in(column: string, value: string[]) {
      filters.push({ method: 'in', column, value });
      return chain;
    },
    is(column: string, value: null) {
      filters.push({ method: 'is', column, value });
      return chain;
    },
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  };

  const update = vi.fn((next: Record<string, unknown>) => {
    values.push(next);
    return chain;
  });
  const from = vi.fn(() => ({ update }));

  return { client: { from }, from, update, filters, values };
}

describe('normalizeUploadIntentPath', () => {
  it('stores paths bucket-relative whichever form the caller holds', () => {
    // The sign response and client payloads carry the 'uploads/' prefix; the
    // post services strip it early so the value can go straight to remove().
    // Rows must key on one form or the two never match.
    expect(normalizeUploadIntentPath('uploads/user-1/abc-media.jpg')).toBe('user-1/abc-media.jpg');
    expect(normalizeUploadIntentPath('user-1/abc-media.jpg')).toBe('user-1/abc-media.jpg');
    expect(normalizeUploadIntentPath('  /uploads/user-1/abc-media.jpg  ')).toBe('user-1/abc-media.jpg');
  });
});

describe('getConfirmedRemovedPaths', () => {
  const requested = ['user-1/a.png', 'user-1/b.png'];

  it('confirms nothing when the remove call itself failed', () => {
    expect(getConfirmedRemovedPaths(requested, { data: null, error: { message: 'outage' } }))
      .toEqual({ confirmed: [], unconfirmed: requested });
  });

  it('splits a partial batch by what storage actually reported deleted', () => {
    // remove() reports per-path outcomes in data with error null. Marking the
    // whole batch cleared on that hides the surviving object from the sweep
    // forever -- it only ever selects uncleared rows.
    expect(getConfirmedRemovedPaths(requested, {
      data: [{ name: 'user-1/a.png' }],
      error: null,
    })).toEqual({
      confirmed: ['user-1/a.png'],
      unconfirmed: ['user-1/b.png'],
    });
  });

  it('trusts a clean result that omits per-path outcomes', () => {
    // Older clients and test doubles return only { error: null }; error is the
    // sole signal available there.
    expect(getConfirmedRemovedPaths(requested, { error: null }))
      .toEqual({ confirmed: requested, unconfirmed: [] });
  });
});

describe('recordMediaUploadIntent', () => {
  it('reports failure so the caller can refuse to hand out an untracked upload', async () => {
    const insert = vi.fn(async () => ({ error: { message: 'table missing' } }));
    const client = { from: vi.fn(() => ({ insert })) };

    await expect(recordMediaUploadIntent(client, {
      userId: 'user-1',
      storagePath: 'uploads/user-1/abc-media.jpg',
      kind: 'image',
      contentType: 'image/jpeg',
      declaredBytes: 2048,
    })).resolves.toEqual({ ok: false, error: 'table missing' });
  });

  it('writes the normalized path with its declared metadata', async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const client = { from: vi.fn(() => ({ insert })) };

    await expect(recordMediaUploadIntent(client, {
      userId: 'user-1',
      storagePath: 'uploads/user-1/abc-media.mp4',
      kind: 'video',
      contentType: 'video/mp4',
      declaredBytes: null,
    })).resolves.toEqual({ ok: true });

    expect(client.from).toHaveBeenCalledWith('media_upload_intents');
    expect(insert).toHaveBeenCalledWith({
      user_id: 'user-1',
      storage_path: 'user-1/abc-media.mp4',
      kind: 'video',
      content_type: 'video/mp4',
      declared_bytes: null,
    });
  });
});

describe('markMediaUploadIntentsConsumed', () => {
  it('sets storage_cleared_at only when the caller already deleted the object', async () => {
    const cleared = updateClientDouble();
    await markMediaUploadIntentsConsumed(cleared.client, {
      storagePaths: ['user-1/a.jpg'],
      consumedBy: 'post_publish',
      storageCleared: true,
    });
    expect(cleared.values[0]).toHaveProperty('storage_cleared_at');
    expect(cleared.values[0].consumed_by).toBe('post_publish');

    // The generation path leaves the staging object in place, because a
    // resubmitted picker selection re-sends the same path and still needs it.
    const retained = updateClientDouble();
    await markMediaUploadIntentsConsumed(retained.client, {
      storagePaths: ['user-1/a.jpg'],
      consumedBy: 'generation_input',
      storageCleared: false,
    });
    expect(retained.values[0]).not.toHaveProperty('storage_cleared_at');
    expect(retained.values[0].consumed_by).toBe('generation_input');
  });

  it('never overwrites an earlier claim', async () => {
    const client = updateClientDouble();
    await markMediaUploadIntentsConsumed(client.client, {
      storagePaths: ['user-1/a.jpg'],
      consumedBy: 'generation_input',
      storageCleared: false,
    });
    expect(client.filters).toContainEqual({ method: 'is', column: 'consumed_at', value: null });
  });

  it('normalizes and de-duplicates the paths it is given', async () => {
    const client = updateClientDouble();
    await markMediaUploadIntentsConsumed(client.client, {
      storagePaths: ['uploads/user-1/a.jpg', 'user-1/a.jpg', 'user-1/b.jpg'],
      consumedBy: 'post_update',
      storageCleared: true,
    });
    expect(client.filters).toContainEqual({
      method: 'in',
      column: 'storage_path',
      value: ['user-1/a.jpg', 'user-1/b.jpg'],
    });
  });

  it('does not issue an update for an empty path list', async () => {
    const client = updateClientDouble();
    await markMediaUploadIntentsConsumed(client.client, {
      storagePaths: [],
      consumedBy: 'post_publish',
      storageCleared: true,
    });
    expect(client.from).not.toHaveBeenCalled();
  });

  it('swallows write failures rather than failing already-published work', async () => {
    const client = updateClientDouble({ message: 'update failed' });
    await expect(markMediaUploadIntentsConsumed(client.client, {
      storagePaths: ['user-1/a.jpg'],
      consumedBy: 'post_publish',
      storageCleared: true,
    })).resolves.toBeUndefined();
  });
});

describe('markMediaUploadIntentsCleared', () => {
  it('records the deletion without claiming anything consumed the bytes', async () => {
    // The publish-failure path rolled the upload back. Marking it consumed
    // would violate the table's consumed pair constraint and overstate how
    // many uploads were actually used.
    const client = updateClientDouble();
    await markMediaUploadIntentsCleared(client.client, ['uploads/user-1/a.jpg']);

    expect(client.values[0]).toHaveProperty('storage_cleared_at');
    expect(client.values[0]).not.toHaveProperty('consumed_at');
    expect(client.values[0]).not.toHaveProperty('consumed_by');
    expect(client.filters).toContainEqual({ method: 'is', column: 'storage_cleared_at', value: null });
  });
});
