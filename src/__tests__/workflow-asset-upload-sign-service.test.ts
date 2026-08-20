import { describe, expect, it, vi } from 'vitest';

import {
  createWorkflowAssetUploadIntent,
  type WorkflowAssetUploadSignClient,
} from '@/lib/workflow-asset-upload-sign';

function createClient({
  allowed = true,
  token = 'workflow-upload-token',
  signedUrl = 'https://storage.example.test/workflow-upload',
  storageError = null as Error | null,
} = {}) {
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'is_account_deletion_requested') {
      return { data: false, error: null };
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
            allowed,
            limit: 40,
            remaining: allowed ? 39 : 0,
            retryAfterSeconds: allowed ? 0 : 37,
            resetAt: '2026-06-22T06:30:00.000Z',
          },
          error: null,
        };
  });
  const createSignedUploadUrl = vi.fn(async () => ({
    data: storageError ? null : { token, signedUrl },
    error: storageError,
  }));
  const from = vi.fn(() => ({ createSignedUploadUrl }));

  return {
    client: {
      rpc,
      storage: { from },
    } satisfies WorkflowAssetUploadSignClient,
    rpc,
    from,
    createSignedUploadUrl,
  };
}

describe('createWorkflowAssetUploadIntent', () => {
  it('rejects invalid workflow asset metadata before rate-limit and storage work', async () => {
    const clientFactory = vi.fn(() => createClient().client);

    await expect(createWorkflowAssetUploadIntent({
      body: {
        bucket: 'generated_images',
        mimeType: 'image/svg+xml',
        fileName: 'logo.svg',
        sizeBytes: 1234,
      },
      userId: 'user-1',
      client: clientFactory,
      createUploadId: () => 'upload-id-1',
    })).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'Upload a valid image file.',
    });

    await expect(createWorkflowAssetUploadIntent({
      body: {
        bucket: 'generated_videos',
        mimeType: 'video/mp4',
        fileName: 'clip.mp4',
        sizeBytes: 251 * 1024 * 1024,
      },
      userId: 'user-1',
      client: clientFactory,
      createUploadId: () => 'upload-id-1',
    })).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'Video uploads must be 250MB or smaller.',
    });

    await expect(createWorkflowAssetUploadIntent({
      body: {
        bucket: 'generated_audio',
        mimeType: 'audio/flac',
        fileName: 'voice.flac',
        sizeBytes: 1234,
      },
      userId: 'user-1',
      client: clientFactory,
      createUploadId: () => 'upload-id-1',
    })).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'Upload a valid audio file.',
    });

    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('enforces workflow upload-sign rate limits and creates a sanitized signed upload intent', async () => {
    const client = createClient();

    const result = await createWorkflowAssetUploadIntent({
      body: {
        bucket: 'generated_images',
        mimeType: 'image/png',
        fileName: '../Workflow Reference?.PNG',
        sizeBytes: 1234,
      },
      userId: 'user-1',
      client: client.client,
      createUploadId: () => 'upload-id-1',
    });

    expect(client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'workflow-asset-upload:sign',
      p_subject_key: 'user-1',
      p_limit: 40,
      p_window_seconds: 600,
    });
    expect(client.rpc).toHaveBeenCalledWith('reserve_upload_bytes_v2', {
      p_upload_id: 'upload-id-1',
      p_user_id: 'user-1',
      p_bucket_id: 'generated_images',
      p_storage_path: 'user-1/workflow-input-upload-id-1-workflow-reference.png',
      p_declared_bytes: 1234,
      p_reserved_bytes: 25 * 1024 * 1024,
      p_expected_content_type: 'image/png',
      p_user_limit_bytes: 1024 * 1024 * 1024,
      p_global_limit_bytes: 100 * 1024 * 1024 * 1024,
      p_ttl_seconds: 2 * 60 * 60,
    });
    expect(client.from).toHaveBeenCalledWith('generated_images');
    expect(client.createSignedUploadUrl).toHaveBeenCalledWith('user-1/workflow-input-upload-id-1-workflow-reference.png');
    expect(client.rpc).toHaveBeenCalledWith('mark_upload_byte_reservation_issued', {
      p_upload_id: 'upload-id-1',
      p_user_id: 'user-1',
      p_token_ttl_seconds: 7200,
    });
    expect(result).toEqual({
      ok: true,
      response: {
        success: true,
        uploadId: 'upload-id-1',
        bucket: 'generated_images',
        path: 'user-1/workflow-input-upload-id-1-workflow-reference.png',
        storagePath: 'generated_images/user-1/workflow-input-upload-id-1-workflow-reference.png',
        token: 'workflow-upload-token',
        signedUploadUrl: 'https://storage.example.test/workflow-upload',
        expiresInSeconds: 7200,
      },
    });
  });

  it('returns stable rate-limit and storage failures', async () => {
    const denied = createClient({ allowed: false });
    await expect(createWorkflowAssetUploadIntent({
      body: {
        bucket: 'generated_videos',
        mimeType: 'video/mp4',
        fileName: 'clip.mp4',
        sizeBytes: 1234,
      },
      userId: 'user-1',
      client: denied.client,
      createUploadId: () => 'upload-id-1',
    })).resolves.toMatchObject({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 37,
    });
    expect(denied.createSignedUploadUrl).not.toHaveBeenCalled();

    const storageFailure = createClient({ storageError: new Error('storage outage') });
    await expect(createWorkflowAssetUploadIntent({
      body: {
        bucket: 'generated_audio',
        mimeType: 'audio/mpeg',
        fileName: 'voice.mp3',
        sizeBytes: 1234,
      },
      userId: 'user-1',
      client: storageFailure.client,
      createUploadId: () => 'upload-id-1',
    })).resolves.toEqual({
      ok: false,
      status: 500,
      error: 'Failed to prepare workflow asset upload.',
    });
  });
});
