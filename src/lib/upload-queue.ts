/**
 * Bounded concurrency for browser uploads.
 *
 * A web twin of the mobile queue in `ugc-mobile/lib/upload-file.ts`. The two
 * apps are separate npm workspaces with no shared package, so this is a
 * deliberate copy rather than an import; both sides are covered by the same test
 * cases so they cannot drift silently.
 *
 * The point is partial success: the composer's old `Promise.all` rejected the
 * whole batch on the first failure, throwing away files that had already
 * uploaded and stranding their staged objects.
 */

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

export class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled.');
    this.name = 'UploadCancelledError';
  }
}

export function isUploadCancelledError(error: unknown): error is UploadCancelledError {
  return error instanceof UploadCancelledError
    || (error instanceof Error && error.name === 'UploadCancelledError');
}

/**
 * Runs at most two image uploads at once. A video consumes both slots, keeping
 * large transfers isolated while preserving the original item order in the
 * returned result.
 */
export async function runWeightedUploadQueue<T, TResult>(
  items: Array<WeightedUploadQueueItem<T>>,
  worker: (item: T, index: number) => Promise<TResult>,
  options: { signal?: AbortSignal } = {},
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
