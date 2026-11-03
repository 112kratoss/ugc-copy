import { describe, expect, it, vi } from 'vitest';

import { dedupeInFlight, isInFlight, trackInFlight } from '../lib/in-flight';

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

// A push registration is sent by every caller under its own session, and the
// rotation listener only needs to know one is under way (lib/notifications.ts).
describe('trackInFlight', () => {
  it('records a request while it is on the wire without sharing it', async () => {
    const owner = {};
    let finish: () => void = () => undefined;
    const request = new Promise<void>((resolve) => { finish = resolve; });

    expect(trackInFlight(owner, 'token', request)).toBe(request);
    expect(isInFlight(owner, 'token')).toBe(true);
    // A second caller sends its own request: nothing hands it the first.
    const own = Promise.resolve();
    expect(trackInFlight(owner, 'token', own)).toBe(own);

    finish();
    await Promise.all([request, own]);
    expect(isInFlight(owner, 'token')).toBe(false);
  });

  it('lets go of a failed request, and hands its failure to its caller only', async () => {
    const owner = {};
    const request = trackInFlight(owner, 'token', Promise.reject(new Error('offline')));

    await expect(request).rejects.toThrow('offline');
    expect(isInFlight(owner, 'token')).toBe(false);
    expect(isInFlight({}, 'token')).toBe(false);
  });

  it('is what dedupeInFlight shares from', async () => {
    const owner = {};
    let finish: (value: string) => void = () => undefined;
    const tracked = trackInFlight(owner, 'library', new Promise<string>((resolve) => { finish = resolve; }));
    const load = vi.fn(async () => 'fresh');

    expect(dedupeInFlight(owner, 'library', load)).toBe(tracked);
    expect(load).not.toHaveBeenCalled();
    finish('done');
    await tracked;
  });
});
