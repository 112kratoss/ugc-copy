/** Serialize autosaves and exit flushes so a slow older write cannot win. */
export function createDraftSaveQueue<T>(write: (value: T) => Promise<void>) {
  let tail: Promise<void> = Promise.resolve();
  return {
    save(value: T) {
      const result = tail.catch(() => undefined).then(() => write(value));
      tail = result;
      return result;
    },
  };
}
