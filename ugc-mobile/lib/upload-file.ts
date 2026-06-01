interface ReadUriUploadBodyOptions {
  mimeType?: string | null;
  sizeBytes?: number | null;
  defaultMimeType?: string;
  readArrayBuffer?: (uri: string) => Promise<ArrayBuffer>;
}

export interface UriUploadBody {
  body: ArrayBuffer;
  mimeType: string;
  sizeBytes: number;
}

export async function readUriUploadBody(
  uri: string,
  {
    mimeType,
    sizeBytes,
    defaultMimeType = 'application/octet-stream',
    readArrayBuffer = readExpoFileArrayBuffer,
  }: ReadUriUploadBodyOptions = {}
): Promise<UriUploadBody> {
  const body = await readArrayBuffer(uri);

  return {
    body,
    mimeType: mimeType || defaultMimeType,
    sizeBytes: sizeBytes ?? body.byteLength,
  };
}

export function getUploadExtension(mimeType: string, fileName?: string | null) {
  if (mimeType.includes('/')) {
    const extension = mimeType.split('/')[1]?.toLowerCase().replace('jpeg', 'jpg').replace('quicktime', 'mov');
    if (extension) return extension;
  }

  const fileExtension = fileName?.split('.').pop()?.toLowerCase();
  return fileExtension && fileExtension !== fileName?.toLowerCase() ? fileExtension : 'bin';
}

async function readExpoFileArrayBuffer(uri: string) {
  const { File: ExpoFile } = await import('expo-file-system');
  const file = new ExpoFile(uri);
  return file.arrayBuffer();
}
