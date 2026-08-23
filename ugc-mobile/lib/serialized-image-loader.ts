/**
 * Guards expo-image's `Image.loadAsync` against its own first use.
 *
 * On iOS, `loadAsync` runs through a process-wide `ImageLoader` whose
 * `SDWebImageManager` is a Swift `lazy var`. Lazy initialisation is not
 * thread-safe: when several loads start together on the cooperative thread
 * pool before any has touched the manager, each creates its own, all but one
 * are released on the spot, and a load already running on a released manager
 * aborts the process ("Cannot form weak reference to instance of class
 * SDWebImageManager"; crash report 2026-08-23 18:43, Showcase grid).
 *
 * The manager is created once per process, so the race exists only until the
 * first load has *completed*. This wrapper lets exactly one call through
 * first, holds the rest until it settles (success or failure), then runs them
 * with a small concurrency cap so a grid's burst does not become a pile-up.
 */
export function createSerializedImageLoader<Source, Options, Result>(
  load: (source: Source, options: Options) => Promise<Result>,
  { maxConcurrent = 6 }: { maxConcurrent?: number } = {}
) {
  let first: Promise<unknown> | null = null;
  let inFlight = 0;
  const waiting: Array<() => void> = [];

  const acquire = () => new Promise<void>((resolve) => {
    if (inFlight < maxConcurrent) {
      inFlight += 1;
      resolve();
      return;
    }
    waiting.push(() => {
      inFlight += 1;
      resolve();
    });
  });

  const release = () => {
    inFlight -= 1;
    waiting.shift()?.();
  };

  return async (source: Source, options: Options): Promise<Result> => {
    if (!first) {
      // The first call carries the initialisation; it runs alone. A failure
      // still counts — the manager exists once the call has returned at all.
      const attempt = load(source, options);
      first = attempt.catch(() => undefined);
      return attempt;
    }

    await first;
    await acquire();
    try {
      return await load(source, options);
    } finally {
      release();
    }
  };
}
