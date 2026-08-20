import { describe, expect, it, vi } from 'vitest';

import {
  createPostResourceFileUploadIntent,
  finalizePostResourceFileUpload,
  type PostResourceFileDirectUploadClient,
} from '@/lib/post-resource-file-direct-upload-service';

function createClient(options: {
  deletionStatus?: string | null;
  infoSize?: number;
  infoContentType?: string;
  rateLimited?: boolean;
} = {}) {
  const createSignedUploadUrl = vi.fn(async () => ({
    data: {
      token: 'signed-upload-token',
      signedUrl: 'https://storage.example/upload',
    },
    error: null,
  }));
  const info = vi.fn(async () => ({
    data: {
      bucketId: 'post_resource_files',
      contentType: options.infoContentType ?? 'application/pdf',
      size: options.infoSize ?? 5,
    },
    error: null,
  }));
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'is_account_deletion_requested') {
      return { data: Boolean(options.deletionStatus), error: null };
    }
    if (fn === 'reserve_upload_bytes_v2') {
      return { data: { allowed: true }, error: null };
    }
    if (
      fn === 'mark_upload_byte_reservation_issued'
      || fn === 'abort_upload_byte_reservation_before_issue'
    ) {
      return { data: true, error: null };
    }
    return {
      data: {
        allowed: !options.rateLimited,
        limit: 30,
        remaining: options.rateLimited ? 0 : 29,
        retryAfterSeconds: options.rateLimited ? 47 : 0,
        resetAt: '2026-07-26T08:00:00.000Z',
      },
      error: null,
    };
  });
  const reservationQuery = {
    eq: vi.fn(() => reservationQuery),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
  };
  const client = {
    rpc,
    from: vi.fn(() => ({ select: vi.fn(() => reservationQuery) })),
    storage: {
      from: vi.fn(() => ({ createSignedUploadUrl, info })),
    },
  } as unknown as PostResourceFileDirectUploadClient;

  return { client, createSignedUploadUrl, info, rpc };
}

const metadata = {
  fileName: 'Launch Guide.PDF',
  contentType: 'application/pdf',
  sizeBytes: 5,
};

describe('post resource direct uploads', () => {
  it('stops signed upload issuance once account deletion has started', async () => {
    const mock = createClient({ deletionStatus: 'storage_deleting' });

    const result = await createPostResourceFileUploadIntent({
      body: metadata,
      client: mock.client,
      createUploadId: () => '11111111-1111-4111-8111-111111111111',
      userId: 'user-1',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      body: { code: 'ACCOUNT_DELETION_IN_PROGRESS' },
    });
    expect(mock.rpc).toHaveBeenCalledTimes(1);
    expect(mock.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('creates a single-path signed intent after validation, deletion guard, and rate limiting', async () => {
    const mock = createClient();

    const result = await createPostResourceFileUploadIntent({
      body: metadata,
      client: mock.client,
      createUploadId: () => '11111111-1111-4111-8111-111111111111',
      userId: 'user-1',
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        uploadId: '11111111-1111-4111-8111-111111111111',
        bucket: 'post_resource_files',
        path: 'user-1/11111111-1111-4111-8111-111111111111-launch-guide.pdf',
        token: 'signed-upload-token',
        signedUploadUrl: 'https://storage.example/upload',
        expiresInSeconds: 7200,
        expected: metadata,
      },
    });
    expect(mock.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post-resource-file:upload',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(mock.createSignedUploadUrl).toHaveBeenCalledWith(
      'user-1/11111111-1111-4111-8111-111111111111-launch-guide.pdf',
    );
    expect(mock.rpc).toHaveBeenCalledWith('mark_upload_byte_reservation_issued', {
      p_upload_id: '11111111-1111-4111-8111-111111111111',
      p_user_id: 'user-1',
      p_token_ttl_seconds: 7200,
    });
  });

  it('will not finalize a path owned by another user', async () => {
    const mock = createClient();

    const result = await finalizePostResourceFileUpload({
      body: {
        ...metadata,
        path: 'other-user/11111111-1111-4111-8111-111111111111-launch-guide.pdf',
      },
      client: mock.client,
      userId: 'user-1',
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(mock.info).not.toHaveBeenCalled();
  });

  it('verifies stored size and MIME metadata before returning an attachment', async () => {
    const mock = createClient();
    const path = 'user-1/11111111-1111-4111-8111-111111111111-launch-guide.pdf';

    const result = await finalizePostResourceFileUpload({
      body: { ...metadata, path },
      client: mock.client,
      userId: 'user-1',
    });

    expect(mock.info).toHaveBeenCalledWith(path);
    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        attachment: {
          label: 'Launch Guide.PDF',
          kind: 'file',
          storagePath: path,
          contentType: 'application/pdf',
          sizeBytes: 5,
        },
      },
    });
  });

  it('rejects a finalized object whose actual size differs from the intent', async () => {
    const mock = createClient({ infoSize: 6 });

    const result = await finalizePostResourceFileUpload({
      body: {
        ...metadata,
        path: 'user-1/11111111-1111-4111-8111-111111111111-launch-guide.pdf',
      },
      client: mock.client,
      userId: 'user-1',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { error: 'Uploaded resource metadata did not match the upload intent.' },
    });
  });
});
