export type FinalizedUploadDescriptor = {
  bucket: string;
  path: string;
  storagePath: string;
  contentType: string;
  sizeBytes: number;
};

export async function finalizeSignedUpload(
  accessToken: string,
  uploadId: string,
  signal?: AbortSignal,
): Promise<FinalizedUploadDescriptor> {
  const response = await fetch('/api/uploads/finalize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ uploadId }),
    signal,
  });
  const body = await response.json() as Partial<FinalizedUploadDescriptor> & { error?: string };
  if (!response.ok) {
    throw new Error(body.error || 'Failed to finalize upload.');
  }
  if (
    typeof body.bucket !== 'string'
    || typeof body.path !== 'string'
    || typeof body.storagePath !== 'string'
    || typeof body.contentType !== 'string'
    || typeof body.sizeBytes !== 'number'
  ) {
    throw new Error('Upload finalization response was invalid.');
  }
  return body as FinalizedUploadDescriptor;
}
