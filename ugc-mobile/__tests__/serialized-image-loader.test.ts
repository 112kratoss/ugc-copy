import { describe, expect, it, vi } from 'vitest';

import { createSerializedImageLoader } from '@/lib/serialized-image-loader';

type Deferred = { promise: Promise<string>; resolve: (value: string) => void; reject: (error: Error) => void };

function deferred(): Deferred {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(maxConcurrent?: number) {
  const pending: Deferred[] = [];
  const load = vi.fn((_source: string, _options: { max: number }) => {
    const entry = deferred();
    pending.push(entry);
    return entry.promise;
  });
  const serialized = createSerializedImageLoader(load, { maxConcurrent });
  return { load, pending, serialized };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createSerializedImageLoader', () => {
  it('lets the first load finish alone before any other starts', async () => {
    const { load, pending, serialized } = harness();

    const first = serialized('a.jpg', { max: 96 });
    const second = serialized('b.jpg', { max: 96 });
    const third = serialized('c.jpg', { max: 96 });
    await tick();
    expect(load).toHaveBeenCalledTimes(1);

    pending[0].resolve('A');
    await tick();
    expect(load).toHaveBeenCalledTimes(3);

    pending[1].resolve('B');
    pending[2].resolve('C');
    await expect(first).resolves.toBe('A');
    await expect(second).resolves.toBe('B');
    await expect(third).resolves.toBe('C');
  });

  it('releases the rest even when the first load fails', async () => {
    const { load, pending, serialized } = harness();

    const first = serialized('a.jpg', { max: 96 });
    const second = serialized('b.jpg', { max: 96 });
    await tick();
    pending[0].reject(new Error('offline'));
    await expect(first).rejects.toThrow('offline');
    await tick();

    expect(load).toHaveBeenCalledTimes(2);
    pending[1].resolve('B');
    await expect(second).resolves.toBe('B');
  });

  it('caps how many later loads run at once', async () => {
    const { load, pending, serialized } = harness(2);

    const first = serialized('warm.jpg', { max: 96 });
    const rest = ['a', 'b', 'c', 'd'].map((name) => serialized(`${name}.jpg`, { max: 96 }));
    await tick();
    pending[0].resolve('W');
    await first;
    await tick();
    expect(load).toHaveBeenCalledTimes(3);

    pending[1].resolve('A');
    await tick();
    expect(load).toHaveBeenCalledTimes(4);

    pending[2].resolve('B');
    pending[3].resolve('C');
    await tick();
    expect(load).toHaveBeenCalledTimes(5);
    pending[4].resolve('D');
    await expect(Promise.all(rest)).resolves.toEqual(['A', 'B', 'C', 'D']);
  });
});
