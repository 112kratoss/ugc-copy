export type MediaBucket = 'generated_images' | 'generated_videos' | 'generated_audio';

export function isMediaBucket(bucket: string): bucket is MediaBucket {
  return bucket === 'generated_images' || bucket === 'generated_videos' || bucket === 'generated_audio';
}

export function getStoredMediaLocation(outputUrl: string): { bucket: MediaBucket; filePath: string } | null {
  if (outputUrl.startsWith('/api/media?')) {
    return null;
  }

  if (outputUrl.startsWith('generated_images/')) {
    return {
      bucket: 'generated_images',
      filePath: outputUrl.replace('generated_images/', ''),
    };
  }

  if (outputUrl.startsWith('generated_videos/')) {
    return {
      bucket: 'generated_videos',
      filePath: outputUrl.replace('generated_videos/', ''),
    };
  }

  if (outputUrl.startsWith('generated_audio/')) {
    return {
      bucket: 'generated_audio',
      filePath: outputUrl.replace('generated_audio/', ''),
    };
  }

  try {
    const url = new URL(outputUrl);
    const match = url.pathname.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/);

    if (!match) {
      return null;
    }

    const [, bucket, rawPath] = match;
    if (!isMediaBucket(bucket)) {
      return null;
    }

    return {
      bucket,
      filePath: decodeURIComponent(rawPath),
    };
  } catch {
    return null;
  }
}

export function buildMediaProxyUrl(bucket: MediaBucket, filePath: string): string {
  const params = new URLSearchParams({
    bucket,
    path: filePath,
  });

  return `/api/media?${params.toString()}`;
}

export function getDisplayMediaUrl(outputUrl: string): string {
  if (!outputUrl) {
    return outputUrl;
  }

  const location = getStoredMediaLocation(outputUrl);
  if (!location) {
    return outputUrl;
  }

  return buildMediaProxyUrl(location.bucket, location.filePath);
}
