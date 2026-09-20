import { describe, expect, it, vi } from 'vitest';
import { RESUMABLE_CHUNK_BYTES as CHUNK, signedResumableTarget, uploadResumable } from '../lib/media-upload/resumable';
const target = signedResumableTarget('https://project.supabase.co/storage/v1/object/upload/sign/uploads/owner%2Fvideo.mp4?token=signed')!;
const location = target.endpoint + '/session';
const reply = (offset: number) => new Response(null, { status: 204, headers: { 'Upload-Offset': String(offset) } });

describe('signed resumable media transfer', () => {
  it('uses the signed TUS endpoint on the direct Storage host', () => {
    expect(target).toEqual({ endpoint: 'https://project.storage.supabase.co/storage/v1/upload/resumable/sign', token: 'signed', bucket: 'uploads', path: 'owner/video.mp4' });
  });
  it('resumes an acknowledged-by-server chunk after losing its response, without replaying bytes', async () => {
    let offset = 0;
    let lost = false;
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init!.method!);
      if (init?.method === 'POST') return new Response(null, { status: 201, headers: { Location: location } });
      if (init?.method === 'HEAD') return reply(offset);
      offset += (init?.body as Uint8Array).length;
      if (!lost) { lost = true; throw new Error('Connection dropped'); }
      return reply(offset);
    });
    const readChunk = vi.fn((start: number, end: number) => new Uint8Array(end - start));
    await uploadResumable({ target, size: CHUNK + 128, contentType: 'video/mp4', readChunk, fetchImpl, wait: async () => undefined });
    expect(methods).toEqual(['POST','PATCH','HEAD','PATCH']);
    expect(readChunk.mock.calls).toEqual([[0, CHUNK], [CHUNK, CHUNK + 128]]);
    expect(offset).toBe(CHUNK + 128);
  });
  it('recognizes an uncertain final success with HEAD', async () => {
    const methods: string[] = [];
    await uploadResumable({ target, size: 5, contentType: 'image/png', readChunk: () => new Uint8Array(5), wait: async () => undefined,
      fetchImpl: async (_url, init) => {
        methods.push(init!.method!);
        if (init?.method === 'POST') return new Response(null, { status: 201, headers: { Location: location } });
        if (init?.method === 'PATCH') throw new Error('Lost acknowledgement');
        return reply(5);
      },
    });
    expect(methods).toEqual(['POST', 'PATCH', 'HEAD']);
  });
  it('does not retry an expired signature or send it to a returned foreign host', async () => {
    for (const response of [new Response(null, { status: 403 }), new Response(null, { status: 201, headers: { Location: 'https://other.test/session' } })]) {
      const fetchImpl = vi.fn(async () => response);
      await expect(uploadResumable({ target, size: 5, contentType: 'image/png', readChunk: () => new Uint8Array(5), fetchImpl })).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
  it('does not read or transfer after cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    const readChunk = vi.fn(); const fetchImpl = vi.fn();
    await expect(uploadResumable({ target, size: 5, contentType: 'image/png', readChunk, fetchImpl, signal: controller.signal })).rejects.toMatchObject({ name: 'UploadCancelledError' });
    expect(readChunk).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('bounds retries when Storage never advances the confirmed offset', async () => {
    const wait = vi.fn(async () => undefined);
    const readChunk = vi.fn(() => new Uint8Array(5));
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(null, { status: 201, headers: { Location: location } });
      if (init?.method === 'HEAD') return reply(0);
      return new Response(null, { status: 503 });
    });
    await expect(uploadResumable({ target, size: 5, contentType: 'video/mp4', readChunk, fetchImpl, wait })).rejects.toThrow('503');
    expect(wait.mock.calls).toHaveLength(5);
    expect(readChunk).toHaveBeenCalledTimes(6);
  });
  it('aborts an in-flight native request and never schedules recovery after cancellation', async () => {
    const controller = new AbortController();
    const wait = vi.fn();
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(new Response(null, { status: 201, headers: { Location: location } }));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        controller.abort();
      });
    });
    await expect(uploadResumable({ target, size: 5, contentType: 'video/mp4', readChunk: () => new Uint8Array(5), fetchImpl, wait, signal: controller.signal })).rejects.toMatchObject({ name: 'UploadCancelledError' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(wait).not.toHaveBeenCalled();
  });

});
