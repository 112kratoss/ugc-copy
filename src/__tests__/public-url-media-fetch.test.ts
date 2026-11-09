import { EventEmitter } from 'node:events';
import type https from 'node:https';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  canonicalContentType,
  fetchPublicHttpsMedia,
  isPublicUnicastAddress,
  mediaKindOfMimeType,
  parsePublicMediaUrl,
  resolvePublicHost,
  sniffMediaKind,
} from '@/lib/public-url-media-fetch';

const CAPS = { image: 25 * 1024 * 1024, video: 250 * 1024 * 1024, audio: 50 * 1024 * 1024 };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const HTML = Buffer.from('<!doctype html><html><body>not a picture</body></html>');

type Answer = {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | Buffer[];
  /** The request's own failure (a refused connection), instead of an answer. */
  error?: Error;
};

/**
 * A stand-in for `https.request`: answers each call from the list, in order, and keeps every
 * call's URL and options, so a test reads which addresses the connection was pinned to.
 */
function transport(answers: Answer[]) {
  const calls: Array<{ url: URL; options: https.RequestOptions }> = [];
  const request = vi.fn((url: URL | string, options: https.RequestOptions, callback?: (response: never) => void) => {
    calls.push({ url: new URL(String(url)), options });
    const answer = answers.shift();
    if (!answer) throw new Error('no answer left');
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.end = () => {
      if (answer.error) {
        queueMicrotask(() => req.emit('error', answer.error));
        return;
      }
      const chunks = Array.isArray(answer.body) ? answer.body : answer.body ? [answer.body] : [];
      const response = Readable.from(chunks) as Readable & { statusCode: number; headers: Record<string, string> };
      response.statusCode = answer.status;
      response.headers = answer.headers ?? {};
      queueMicrotask(() => callback?.(response as never));
    };
    req.destroy = vi.fn();
    return req as unknown as ReturnType<typeof https.request>;
  });
  return { request: request as unknown as typeof https.request, calls, destroyed: () => calls.length };
}

const publicLookup = async () => ['93.184.216.34'];

describe('the address and host checks', () => {
  it.each([
    ['127.0.0.1', false], ['127.8.8.8', false], ['10.1.2.3', false], ['172.16.0.9', false], ['172.31.255.255', false],
    ['192.168.1.1', false], ['169.254.169.254', false], ['100.64.0.1', false], ['0.0.0.0', false], ['224.0.0.1', false],
    ['255.255.255.255', false], ['198.18.0.1', false], ['192.0.2.1', false],
    ['::1', false], ['::', false], ['fe80::1', false], ['fc00::1', false], ['fd12::1', false], ['ff02::1', false],
    ['::ffff:127.0.0.1', false], ['::ffff:10.0.0.1', false], ['::ffff:7f00:1', false], ['64:ff9b::7f00:1', false],
    ['2002:7f00:1::1', false], ['2001:0:1::1', false], ['2001:db8::1', false],
    ['8.8.8.8', true], ['93.184.216.34', true], ['172.32.0.1', true], ['2606:4700::6810:84e5', true], ['::ffff:8.8.8.8', true],
    ['not-an-address', false],
  ])('%s public: %s', (address, expected) => {
    expect(isPublicUnicastAddress(address)).toBe(expected);
  });

  it('refuses a private name before resolving it, and a host whose answers include one private address', async () => {
    const lookup = vi.fn(async () => ['93.184.216.34']);
    for (const host of ['localhost', 'db.internal', 'printer.local', 'metadata.google.internal', 'host.home.arpa']) {
      const result = await resolvePublicHost(host, lookup);
      expect(result.ok, host).toBe(false);
      expect(!result.ok && result.code).toBe('PRIVATE_ADDRESS');
    }
    expect(lookup).not.toHaveBeenCalled();

    const mixed = await resolvePublicHost('cdn.example.com', async () => ['93.184.216.34', '10.0.0.5']);
    expect(!mixed.ok && mixed.code).toBe('PRIVATE_ADDRESS');
    const literal = await resolvePublicHost('[::1]', lookup);
    expect(!literal.ok && literal.code).toBe('PRIVATE_ADDRESS');
    const unresolved = await resolvePublicHost('nowhere.example.com', async () => { throw new Error('ENOTFOUND'); });
    expect(!unresolved.ok && unresolved.code).toBe('UNRESOLVABLE_HOST');
    const empty = await resolvePublicHost('nowhere.example.com', async () => []);
    expect(!empty.ok && empty.code).toBe('UNRESOLVABLE_HOST');
    const fine = await resolvePublicHost('cdn.example.com', async () => ['93.184.216.34', '2606:4700::1']);
    expect(fine).toEqual({ ok: true, addresses: ['93.184.216.34', '2606:4700::1'] });
  });

  it('takes https on the default port with no credentials and nothing else', () => {
    expect(parsePublicMediaUrl('https://cdn.example.com/a.jpg').ok).toBe(true);
    expect(parsePublicMediaUrl('https://cdn.example.com:443/a.jpg').ok).toBe(true);
    for (const value of ['http://cdn.example.com/a.jpg', 'ftp://cdn.example.com/a.jpg', 'https://user:pw@cdn.example.com/a.jpg', 'https://cdn.example.com:8443/a.jpg', 'not a url', 'file:///etc/passwd']) {
      const result = parsePublicMediaUrl(value);
      expect(result.ok, value).toBe(false);
      expect(!result.ok && result.code).toBe('INVALID_URL');
    }
  });

  it('reads a type from its header and a kind from the first bytes', () => {
    expect(canonicalContentType('image/JPEG; charset=binary')).toBe('image/jpeg');
    expect(canonicalContentType('audio/x-m4a')).toBe('audio/mp4');
    expect(canonicalContentType(undefined)).toBe('');
    expect(mediaKindOfMimeType('video/mp4')).toBe('video');
    expect(mediaKindOfMimeType('text/html')).toBeNull();
    expect(sniffMediaKind(JPEG)).toBe('image');
    expect(sniffMediaKind(PNG)).toBe('image');
    expect(sniffMediaKind(Buffer.concat([Buffer.from('RIFF....WEBPVP8 ')]))).toBe('image');
    expect(sniffMediaKind(Buffer.concat([Buffer.from('RIFF....WAVEfmt ')]))).toBe('audio');
    expect(sniffMediaKind(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(8)]))).toBe('video');
    expect(sniffMediaKind(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(8)]))).toBe('image');
    expect(sniffMediaKind(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(8)]))).toBe('audio');
    expect(sniffMediaKind(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]))).toBe('video');
    expect(sniffMediaKind(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(12)]))).toBe('audio');
    expect(sniffMediaKind(HTML)).toBeNull();
    expect(sniffMediaKind(Buffer.alloc(4))).toBeNull();
  });
});

describe('fetchPublicHttpsMedia', () => {
  it('fetches a picture from a public host over a connection pinned to the resolved addresses', async () => {
    const lookup = vi.fn(async () => ['93.184.216.34', '2606:4700::1']);
    const { request, calls } = transport([{ status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(JPEG.length) }, body: JPEG }]);
    const result = await fetchPublicHttpsMedia('https://cdn.example.com/photo.jpg?x=1', { maxBytesByKind: CAPS, lookup, request });
    expect(result).toMatchObject({ ok: true, contentType: 'image/jpeg', kind: 'image', finalUrl: 'https://cdn.example.com/photo.jpg?x=1' });
    expect(result.ok && result.bytes.equals(JPEG)).toBe(true);
    expect(lookup).toHaveBeenCalledWith('cdn.example.com');
    expect(calls).toHaveLength(1);
    expect(calls[0].options.headers).toMatchObject({ 'user-agent': expect.stringContaining('Magicbooklet') });
    // The connection's own lookup answers the checked addresses and nothing it resolves itself.
    const pinned = calls[0].options.lookup as unknown as (host: string, options: unknown, cb: (...args: unknown[]) => void) => void;
    const single = vi.fn();
    pinned('cdn.example.com', { family: 0 }, single);
    expect(single).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    const all = vi.fn();
    pinned('cdn.example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1', family: 6 }]);
  });

  it('refuses a private host, an http URL and a host that resolves to a private address without connecting', async () => {
    const { request, calls } = transport([]);
    const base = { maxBytesByKind: CAPS, request };
    expect(await fetchPublicHttpsMedia('http://cdn.example.com/a.jpg', { ...base, lookup: publicLookup })).toMatchObject({ ok: false, code: 'INVALID_URL' });
    expect(await fetchPublicHttpsMedia('https://localhost/a.jpg', { ...base, lookup: publicLookup })).toMatchObject({ ok: false, code: 'PRIVATE_ADDRESS' });
    expect(await fetchPublicHttpsMedia('https://169.254.169.254/latest/meta-data', { ...base, lookup: publicLookup })).toMatchObject({ ok: false, code: 'PRIVATE_ADDRESS' });
    expect(await fetchPublicHttpsMedia('https://rebind.example.com/a.jpg', { ...base, lookup: async () => ['10.0.0.1'] })).toMatchObject({ ok: false, code: 'PRIVATE_ADDRESS' });
    expect(calls).toHaveLength(0);
  });

  it('follows one redirect on the same host, resolving it again, and refuses one off the host or a second one', async () => {
    const lookup = vi.fn(async () => ['93.184.216.34']);
    const same = transport([
      { status: 302, headers: { location: '/moved/photo.jpg' } },
      { status: 200, headers: { 'content-type': 'image/png' }, body: PNG },
    ]);
    const followed = await fetchPublicHttpsMedia('https://cdn.example.com/photo.jpg', { maxBytesByKind: CAPS, lookup, request: same.request });
    expect(followed).toMatchObject({ ok: true, kind: 'image', finalUrl: 'https://cdn.example.com/moved/photo.jpg' });
    expect(same.calls.map((call) => call.url.pathname)).toEqual(['/photo.jpg', '/moved/photo.jpg']);
    expect(lookup).toHaveBeenCalledTimes(2);

    const offHost = transport([{ status: 301, headers: { location: 'https://other.example.net/photo.jpg' } }]);
    const refused = await fetchPublicHttpsMedia('https://cdn.example.com/photo.jpg', { maxBytesByKind: CAPS, lookup, request: offHost.request });
    expect(refused).toMatchObject({ ok: false, code: 'REDIRECT_REFUSED', details: { redirect_host: 'other.example.net' } });
    expect(offHost.calls).toHaveLength(1);

    const toHttp = transport([{ status: 307, headers: { location: 'http://cdn.example.com/photo.jpg' } }]);
    expect(await fetchPublicHttpsMedia('https://cdn.example.com/photo.jpg', { maxBytesByKind: CAPS, lookup, request: toHttp.request })).toMatchObject({ ok: false, code: 'REDIRECT_REFUSED' });

    const twice = transport([
      { status: 302, headers: { location: '/a.jpg' } },
      { status: 302, headers: { location: '/b.jpg' } },
    ]);
    expect(await fetchPublicHttpsMedia('https://cdn.example.com/photo.jpg', { maxBytesByKind: CAPS, lookup, request: twice.request })).toMatchObject({ ok: false, code: 'REDIRECT_REFUSED' });
    expect(twice.calls).toHaveLength(2);
  });

  it('refuses a body over the kind\'s cap by its declared length, and again as it streams', async () => {
    const caps = { image: 100, video: 1000, audio: 1000 };
    const declared = transport([{ status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '101' }, body: JPEG }]);
    expect(await fetchPublicHttpsMedia('https://cdn.example.com/a.jpg', { maxBytesByKind: caps, lookup: publicLookup, request: declared.request }))
      .toMatchObject({ ok: false, code: 'TOO_LARGE', details: { bytes: 101, max_bytes: 100 } });

    const streamed = transport([{ status: 200, headers: { 'content-type': 'image/jpeg' }, body: [JPEG.subarray(0, 60), Buffer.alloc(60, 3)] }]);
    expect(await fetchPublicHttpsMedia('https://cdn.example.com/a.jpg', { maxBytesByKind: caps, lookup: publicLookup, request: streamed.request }))
      .toMatchObject({ ok: false, code: 'TOO_LARGE', details: { max_bytes: 100 } });

    // A clip's cap is the clip's: the same bytes under video/mp4 pass the larger limit.
    const clip = transport([{ status: 200, headers: { 'content-type': 'video/mp4' }, body: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(108)]) }]);
    expect(await fetchPublicHttpsMedia('https://cdn.example.com/a.mp4', { maxBytesByKind: caps, lookup: publicLookup, request: clip.request })).toMatchObject({ ok: true, kind: 'video' });
  });

  it('refuses a type the storage policy does not take, judged by the header and then by the bytes, never by the extension', async () => {
    const html = transport([{ status: 200, headers: { 'content-type': 'text/html' }, body: HTML }]);
    expect(await fetchPublicHttpsMedia('https://cdn.example.com/photo.jpg', { maxBytesByKind: CAPS, lookup: publicLookup, request: html.request }))
      .toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { content_type: 'text/html' } });

    const svg = transport([{ status: 200, headers: { 'content-type': 'image/svg+xml' }, body: Buffer.from('<svg/>') }]);
    expect(await fetchPublicHttpsMedia('https://cdn.example.com/a.svg', { maxBytesByKind: CAPS, lookup: publicLookup, request: svg.request }))
      .toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA' });

    // A page served as a picture: the header says image, the bytes say otherwise.
    const lying = transport([{ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(32)]) }]);
    expect(await fetchPublicHttpsMedia('https://cdn.example.com/a.png', { maxBytesByKind: CAPS, lookup: publicLookup, request: lying.request }))
      .toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { content_type: 'image/png', sniffed_kind: 'audio' } });

    // No signature known for the bytes: the header stands (a HEIF variant, a raw stream).
    const unsigned = transport([{ status: 200, headers: { 'content-type': 'image/webp' }, body: Buffer.alloc(40, 7) }]);
    expect(await fetchPublicHttpsMedia('https://cdn.example.com/a', { maxBytesByKind: CAPS, lookup: publicLookup, request: unsigned.request })).toMatchObject({ ok: true, contentType: 'image/webp' });

    // A picker's alias is kept under the listed name.
    const alias = transport([{ status: 200, headers: { 'content-type': 'audio/x-m4a' }, body: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(8)]) }]);
    expect(await fetchPublicHttpsMedia('https://cdn.example.com/a.m4a', { maxBytesByKind: CAPS, lookup: publicLookup, request: alias.request })).toMatchObject({ ok: true, contentType: 'audio/mp4', kind: 'audio' });
  });

  it('answers an HTTP error, a failed connection and a deadline as their own codes', async () => {
    const notFound = transport([{ status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('gone') }]);
    expect(await fetchPublicHttpsMedia('https://cdn.example.com/a.jpg', { maxBytesByKind: CAPS, lookup: publicLookup, request: notFound.request }))
      .toMatchObject({ ok: false, code: 'HTTP_ERROR', details: { status: 404 } });

    const refused = transport([{ status: 0, error: new Error('ECONNREFUSED') }]);
    expect(await fetchPublicHttpsMedia('https://cdn.example.com/a.jpg', { maxBytesByKind: CAPS, lookup: publicLookup, request: refused.request }))
      .toMatchObject({ ok: false, code: 'NETWORK_ERROR' });

    const late = transport([]);
    expect(await fetchPublicHttpsMedia('https://cdn.example.com/a.jpg', { maxBytesByKind: CAPS, lookup: publicLookup, request: late.request, timeoutMs: 0 }))
      .toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(late.calls).toHaveLength(0);
  });
});
