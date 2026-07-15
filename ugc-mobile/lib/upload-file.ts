interface InspectUriUploadOptions {
  mimeType?: string | null;
  sizeBytes?: number | null;
  defaultMimeType?: string;
  inspectFile?: (uri: string) => Promise<UriFileInfo>;
}

export interface UriFileInfo {
  exists: boolean;
  mimeType?: string | null;
  sizeBytes: number;
}

export interface UriUploadDescriptor {
  mimeType: string;
  sizeBytes: number;
}

export interface UriUploadProgress {
  bytesSent: number;
  totalBytes: number;
  fraction: number;
}

interface NativeUploadResult {
  body?: string;
  status: number;
}

interface NativeUploadTask {
  cancelAsync: () => Promise<void>;
  uploadAsync: () => Promise<NativeUploadResult | null | undefined>;
}

interface UploadUriToSignedUrlOptions {
  mimeType: string;
  onProgress?: (progress: UriUploadProgress) => void;
  signal?: AbortSignal;
  sizeBytes: number;
  createUploadTask?: (
    signedUploadUrl: string,
    uri: string,
    options: {
      headers: Record<string, string>;
      httpMethod: 'PUT';
      uploadType: number;
    },
    onProgress: (progress: { totalBytesExpectedToSend: number; totalBytesSent: number }) => void
  ) => Promise<NativeUploadTask>;
}

export interface WeightedUploadQueueItem<T> {
  item: T;
  kind: 'image' | 'video';
}

export interface WeightedUploadQueueSuccess<T, TResult> extends WeightedUploadQueueItem<T> {
  index: number;
  result: TResult;
}

export interface WeightedUploadQueueFailure<T> extends WeightedUploadQueueItem<T> {
  error: unknown;
  index: number;
}

export interface WeightedUploadQueueResult<T, TResult> {
  failures: Array<WeightedUploadQueueFailure<T>>;
  successes: Array<WeightedUploadQueueSuccess<T, TResult>>;
}

/**
 * Reads only native file metadata. Unlike the old ArrayBuffer path, this never
 * copies the file's bytes into the JavaScript heap.
 */
export async function inspectUriUpload(
  uri: string,
  {
    mimeType,
    sizeBytes,
    defaultMimeType = 'application/octet-stream',
    inspectFile = inspectExpoFile,
  }: InspectUriUploadOptions = {}
): Promise<UriUploadDescriptor> {
  const file = await inspectFile(uri);

  if (!file.exists) {
    throw new Error('The selected file is no longer available. Choose it again.');
  }

  const actualSize = normalizeFileSize(file.sizeBytes);
  if (actualSize === null) {
    throw new Error('Could not determine the selected file size. Choose it again.');
  }

  if (sizeBytes != null && normalizeFileSize(sizeBytes) === null) {
    throw new Error('The selected file has an invalid size.');
  }

  return {
    mimeType: normalizeMimeType(mimeType) || normalizeMimeType(file.mimeType) || defaultMimeType,
    sizeBytes: actualSize,
  };
}

/**
 * Streams a local URI through the platform networking stack. The upload task
 * reads the file natively, reports byte progress, and can be cancelled without
 * allocating a file-sized JS buffer.
 */
export async function uploadUriToSignedUrl(
  uri: string,
  signedUploadUrl: string,
  {
    mimeType,
    onProgress,
    signal,
    sizeBytes,
    createUploadTask = createExpoUploadTask,
  }: UploadUriToSignedUrlOptions
) {
  if (signal?.aborted) {
    throw new UploadCancelledError();
  }

  const task = await createUploadTask(
    signedUploadUrl,
    uri,
    {
      headers: {
        'cache-control': 'max-age=3600',
        'content-type': mimeType,
        'x-upsert': 'false',
      },
      httpMethod: 'PUT',
      // expo-file-system's BINARY_CONTENT enum is stable at zero.
      uploadType: 0,
    },
    ({ totalBytesExpectedToSend, totalBytesSent }) => {
      const totalBytes = normalizeProgressBytes(totalBytesExpectedToSend, sizeBytes);
      const bytesSent = Math.min(totalBytes, Math.max(0, totalBytesSent));
      onProgress?.({
        bytesSent,
        totalBytes,
        fraction: totalBytes > 0 ? bytesSent / totalBytes : 0,
      });
    }
  );

  const cancelUpload = () => {
    void task.cancelAsync().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancelUpload, { once: true });

  try {
    const result = await task.uploadAsync();
    if (signal?.aborted || !result) {
      throw new UploadCancelledError();
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(formatUploadFailure(result.status, result.body));
    }

    onProgress?.({ bytesSent: sizeBytes, totalBytes: sizeBytes, fraction: 1 });
  } finally {
    signal?.removeEventListener('abort', cancelUpload);
  }
}

/**
 * Runs at most two image uploads at once. A video consumes both slots, keeping
 * large native transfers isolated while preserving the original item order in
 * the returned result.
 */
export async function runWeightedUploadQueue<T, TResult>(
  items: Array<WeightedUploadQueueItem<T>>,
  worker: (item: T, index: number) => Promise<TResult>,
  options: { signal?: AbortSignal } = {}
): Promise<WeightedUploadQueueResult<T, TResult>> {
  const successes: Array<WeightedUploadQueueSuccess<T, TResult>> = [];
  const failures: Array<WeightedUploadQueueFailure<T>> = [];
  const capacity = 2;
  let activeWeight = 0;
  let cursor = 0;
  let running = 0;
  let resolved = false;

  return new Promise((resolve) => {
    const finish = () => {
      if (resolved) return;
      resolved = true;
      successes.sort((left, right) => left.index - right.index);
      failures.sort((left, right) => left.index - right.index);
      resolve({ successes, failures });
    };

    const markRemainingCancelled = () => {
      while (cursor < items.length) {
        const entry = items[cursor];
        failures.push({ ...entry, index: cursor, error: new UploadCancelledError() });
        cursor += 1;
      }
    };

    const schedule = () => {
      if (options.signal?.aborted) {
        markRemainingCancelled();
        if (running === 0) finish();
        return;
      }

      while (cursor < items.length) {
        const entry = items[cursor];
        const weight = entry.kind === 'video' ? capacity : 1;
        if (activeWeight + weight > capacity) break;

        const index = cursor;
        cursor += 1;
        activeWeight += weight;
        running += 1;

        void Promise.resolve()
          .then(() => worker(entry.item, index))
          .then((result) => {
            successes.push({ ...entry, index, result });
          })
          .catch((error) => {
            failures.push({ ...entry, index, error });
          })
          .finally(() => {
            activeWeight -= weight;
            running -= 1;
            if (cursor >= items.length && running === 0) {
              finish();
              return;
            }
            schedule();
          });
      }

      if (cursor >= items.length && running === 0) finish();
    };

    schedule();
  });
}

export class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled.');
    this.name = 'UploadCancelledError';
  }
}

export function isUploadCancelledError(error: unknown): error is UploadCancelledError {
  return error instanceof UploadCancelledError || (error instanceof Error && error.name === 'UploadCancelledError');
}

export function getUploadExtension(mimeType: string, fileName?: string | null) {
  if (mimeType.includes('/')) {
    const extension = mimeType.split('/')[1]?.toLowerCase().replace('jpeg', 'jpg').replace('quicktime', 'mov');
    if (extension) return extension;
  }

  const fileExtension = fileName?.split('.').pop()?.toLowerCase();
  return fileExtension && fileExtension !== fileName?.toLowerCase() ? fileExtension : 'bin';
}

function normalizeMimeType(value: string | null | undefined) {
  return value?.split(';')[0]?.trim().toLowerCase() ?? '';
}

function normalizeFileSize(value: number) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeProgressBytes(reported: number, fallback: number) {
  return Number.isFinite(reported) && reported > 0 ? reported : fallback;
}

function formatUploadFailure(status: number, body: string | undefined) {
  const generic = `Upload failed with status ${status}.`;
  if (!body) return generic;

  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    const message = parsed.message || parsed.error;
    return typeof message === 'string' && message.trim() ? message.trim().slice(0, 240) : generic;
  } catch {
    return generic;
  }
}

async function inspectExpoFile(uri: string): Promise<UriFileInfo> {
  const { File: ExpoFile } = await import('expo-file-system');
  const file = new ExpoFile(uri);
  return {
    exists: file.exists,
    mimeType: file.type,
    sizeBytes: file.size,
  };
}

async function createExpoUploadTask(
  signedUploadUrl: string,
  uri: string,
  options: {
    headers: Record<string, string>;
    httpMethod: 'PUT';
    uploadType: number;
  },
  onProgress: (progress: { totalBytesExpectedToSend: number; totalBytesSent: number }) => void
): Promise<NativeUploadTask> {
  // Keeping the dynamic import out of module scope prevents native filesystem
  // initialization during SSR and unit tests.
  const FileSystem = await import('expo-file-system/legacy');
  return FileSystem.createUploadTask(
    signedUploadUrl,
    uri,
    {
      ...options,
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    },
    onProgress
  );
}
