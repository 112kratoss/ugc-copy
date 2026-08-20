import { supabase } from '@/lib/supabase';
import { finalizeSignedUpload } from '@/lib/upload-finalize-client';

export type WorkflowAssetUploadBucket = 'generated_images' | 'generated_videos' | 'generated_audio';

type WorkflowAssetUploadIntent = {
  success: boolean;
  uploadId: string;
  bucket: WorkflowAssetUploadBucket;
  path: string;
  storagePath: string;
  token: string;
  signedUploadUrl: string | null;
  expiresInSeconds: number;
};

type WorkflowAssetReadUrlResponse = {
  success: boolean;
  signedUrl: string;
  expiresInSeconds: number;
};

export async function uploadWorkflowAssetWithSignedIntent(
  file: File,
  bucket: WorkflowAssetUploadBucket
): Promise<{ signedUrl: string; storagePath: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Please log in to upload media.');
  }

  const mimeType = file.type || 'application/octet-stream';
  const response = await fetch('/api/uploads/workflow-asset/sign', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      bucket,
      fileName: file.name || 'workflow-input.bin',
      mimeType,
      sizeBytes: file.size,
    }),
  });

  const uploadIntent = await response.json() as Partial<WorkflowAssetUploadIntent> & { error?: string };
  if (!response.ok) {
    throw new Error(uploadIntent.error || 'Failed to prepare workflow asset upload.');
  }

  if (
    uploadIntent.bucket !== bucket
    || !uploadIntent.path
    || !uploadIntent.storagePath
    || !uploadIntent.uploadId
    || !uploadIntent.token
  ) {
    throw new Error('Workflow asset upload response was invalid.');
  }

  const { error: uploadError } = await supabase.storage.from(uploadIntent.bucket).uploadToSignedUrl(
    uploadIntent.path,
    uploadIntent.token,
    file,
    { contentType: mimeType }
  );

  if (uploadError) {
    throw new Error(`Workflow asset upload failed: ${uploadError.message}`);
  }

  const finalized = await finalizeSignedUpload(session.access_token, uploadIntent.uploadId);
  if (finalized.bucket !== uploadIntent.bucket || finalized.path !== uploadIntent.path) {
    throw new Error('Finalized workflow asset did not match its signed target.');
  }

  const readUrlResponse = await fetch('/api/uploads/workflow-asset/read-url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      storagePath: finalized.storagePath,
    }),
  });

  const readUrl = await readUrlResponse.json() as Partial<WorkflowAssetReadUrlResponse> & { error?: string };
  if (!readUrlResponse.ok || !readUrl.signedUrl) {
    throw new Error(readUrl.error || 'Failed to prepare workflow asset preview.');
  }

  return {
    signedUrl: readUrl.signedUrl,
    storagePath: finalized.storagePath,
  };
}
