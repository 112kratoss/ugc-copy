import { describe, expect, it, vi } from 'vitest';
import { createDraftSaveQueue } from '../lib/draft-save-queue';

describe('draft save ordering', () => {
  it('finishes an older autosave before the final close snapshot', async () => {
    let finish!: () => void;
    const oldWrite = new Promise<void>((resolve) => { finish = resolve; });
    const write = vi.fn().mockReturnValueOnce(oldWrite).mockResolvedValue(undefined);
    const queue = createDraftSaveQueue(write);
    const first = queue.save('old prompt');
    const close = queue.save('last keystroke');
    await Promise.resolve(); await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    finish();
    await first; await close;
    expect(write.mock.calls.map(([value]) => value)).toEqual(['old prompt', 'last keystroke']);
  });

  it('reports save failure and allows an explicit retry', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const queue = createDraftSaveQueue(write);
    await expect(queue.save('prompt')).rejects.toThrow('disk full');
    await expect(queue.save('prompt')).resolves.toBeUndefined();
  });
});
