import { describe, expect, it, vi } from 'vitest';

import { dedupeInFlight } from '../lib/in-flight';

describe('dedupeInFlight', () => {
  it('shares a request while it is on the wire, then lets the next caller read again', async () => {
    const owner = {};
    let finish: (value: string) => void = () => undefined;
    const load = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));

    const first = dedupeInFlight(owner, 'library', load);
    const second = dedupeInFlight(owner, 'library', load);
    expect(second).toBe(first);

    finish('done');
    await expect(first).resolves.toBe('done');

    load.mockImplementationOnce(async () => 'again');
    await expect(dedupeInFlight(owner, 'library', load)).resolves.toBe('again');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('releases a failed request, so a retry is not handed the same failure', async () => {
    const owner = {};
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('recovered');

    await expect(dedupeInFlight(owner, 'library', load)).rejects.toThrow('offline');
    await expect(dedupeInFlight(owner, 'library', load)).resolves.toBe('recovered');
  });

  it('keeps different owners and keys apart', async () => {
    const load = vi.fn(async () => 'value');

    await Promise.all([
      dedupeInFlight({}, 'library', load),
      dedupeInFlight({}, 'library', load),
      dedupeInFlight(load, 'detail', load),
    ]);

    expect(load).toHaveBeenCalledTimes(3);
  });
});
