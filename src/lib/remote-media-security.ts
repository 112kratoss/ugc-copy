import 'server-only';

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import {
  isAllowedStorageMediaMimeType,
  type StorageMediaKind,
} from '@/lib/storage-upload-mime-policy';

export type RemoteMediaKind = StorageMediaKind;

const MAX_REMOTE_MEDIA_BYTES: Record<RemoteMediaKind, number> = {
  image: 25 * 1024 * 1024,
  video: 250 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
};

const MAX_REDIRECTS = 3;

export class RemoteMediaSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteMediaSecurityError';
  }
}

type LookupAddress = { address: string; family: number };

type RemoteMediaDownloadDependencies = {
  fetcher?: typeof fetch;
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  allowedHosts?: Iterable<string>;
};

export type AllowlistedRemoteMediaStream = {
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentType: string;
  sourceName: string;
};

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function configuredRemoteMediaHosts(): Set<string> {
  const hosts = new Set<string>();
  if (process.env.NODE_ENV === 'test') {
    hosts.add('*.example.com');
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (supabaseUrl) {
    try {
      hosts.add(normalizeHost(new URL(supabaseUrl).hostname));
    } catch {
      // Environment validation reports malformed Supabase URLs separately.
    }
  }

  for (const value of (process.env.MEDIA_IMPORT_HOST_ALLOWLIST ?? '').split(',')) {
    const host = normalizeHost(value);
    if (host) hosts.add(host);
  }

  return hosts;
}

function hostMatchesAllowlist(hostname: string, allowedHosts: Iterable<string>): boolean {
  const host = normalizeHost(hostname);
  for (const rawAllowedHost of allowedHosts) {
    const allowedHost = normalizeHost(rawAllowedHost);
    if (!allowedHost) continue;
    if (allowedHost.startsWith('*.')) {
      const suffix = allowedHost.slice(1);
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
      continue;
    }
    if (host === allowedHost) return true;
  }
  return false;
}

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const octets = address.split('.').map(Number);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function expandIpv6(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let normalized = address.toLowerCase().split('%')[0] ?? '';
  const ipv4Tail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const octets = parseIpv4(ipv4Tail);
    if (!octets) return null;
    normalized = normalized.slice(0, -ipv4Tail.length)
      + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

export function isPrivateOrSpecialIp(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [a, b] = ipv4;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }

  const words = expandIpv6(address);
  if (!words) return true;
  const [first, second, third, fourth, , sixth, seventh, eighth] = words;

  // Unspecified, loopback, IPv4-compatible, and IPv4-mapped forms.
  if (words.slice(0, 7).every((word) => word === 0) && eighth <= 1) return true;
  if (words.slice(0, 6).every((word) => word === 0)) return true;
  if (words.slice(0, 5).every((word) => word === 0) && sixth === 0xffff) {
    return isPrivateOrSpecialIp(`${seventh >> 8}.${seventh & 0xff}.${eighth >> 8}.${eighth & 0xff}`);
  }

  // Unique-local, link-local, multicast, discard-only, documentation,
  // benchmarking, Teredo, ORCHID, and locally assigned translation prefixes.
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (first === 0x0100 && second === 0 && third === 0 && fourth === 0) return true;
  if (first === 0x2001 && second === 0x0db8) return true;
  if (first === 0x2001 && (second === 0 || second === 2 || (second >= 0x10 && second <= 0x1f))) return true;
  if (first === 0x0064 && second === 0xff9b && third === 1) return true;

  // For 6to4, reject prefixes embedding a non-public IPv4 address.
  if (first === 0x2002) {
    const embedded = `${second >> 8}.${second & 0xff}.${third >> 8}.${third & 0xff}`;
    if (isPrivateOrSpecialIp(embedded)) return true;
  }

  // Fail closed for address space outside today's global-unicast 2000::/3.
  return (first & 0xe000) !== 0x2000;
}

function parseAndValidateRemoteUrl(value: string, allowedHosts: Iterable<string>): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteMediaSecurityError('Remote media URL is invalid.');
  }

  if (url.protocol !== 'https:') {
    throw new RemoteMediaSecurityError('Remote media imports require HTTPS.');
  }
  if (url.username || url.password) {
    throw new RemoteMediaSecurityError('Remote media URLs cannot contain credentials.');
  }
  if (url.port && url.port !== '443') {
    throw new RemoteMediaSecurityError('Remote media URL uses a disallowed port.');
  }
  if (!hostMatchesAllowlist(url.hostname, allowedHosts)) {
    throw new RemoteMediaSecurityError('Remote media host is not allowlisted.');
  }

  return url;
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  if (process.env.NODE_ENV === 'test' && normalizeHost(hostname).endsWith('.example.com')) {
    return [{ address: '8.8.8.8', family: 4 }];
  }
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function assertPublicDns(
  hostname: string,
  lookup: (hostname: string) => Promise<LookupAddress[]>,
): Promise<void> {
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname);

  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateOrSpecialIp(address))) {
    throw new RemoteMediaSecurityError('Remote media host resolves to a private or unsafe address.');
  }
}

function validateContentType(response: Response, kind: RemoteMediaKind): string {
  const contentType = (readResponseHeader(response, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!isAllowedStorageMediaMimeType(kind, contentType)) {
    throw new RemoteMediaSecurityError(`Remote response is not valid ${kind} media.`);
  }
  return contentType;
}

function readResponseHeader(response: Response, name: string): string | null {
  // Native fetch responses always expose Headers, but keeping this boundary
  // defensive ensures malformed adapters fail closed with a security error
  // instead of throwing an unrelated TypeError.
  return response.headers?.get?.(name) ?? null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function hasIsoBaseMediaSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp';
}

function hasMediaSignature(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === 'image/png') {
    return bytes.length >= 8
      && bytes[0] === 0x89
      && ascii(bytes, 1, 3) === 'PNG'
      && bytes[4] === 0x0d
      && bytes[5] === 0x0a
      && bytes[6] === 0x1a
      && bytes[7] === 0x0a;
  }
  if (contentType === 'image/gif') {
    const signature = ascii(bytes, 0, 6);
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  if (contentType === 'image/webp') {
    return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP';
  }
  if (contentType === 'image/avif' || contentType === 'image/heic' || contentType === 'image/heif') {
    return hasIsoBaseMediaSignature(bytes);
  }
  if (contentType === 'video/webm' || contentType === 'audio/webm') {
    return bytes.length >= 4
      && bytes[0] === 0x1a
      && bytes[1] === 0x45
      && bytes[2] === 0xdf
      && bytes[3] === 0xa3;
  }
  if (contentType === 'video/mp4' || contentType === 'video/quicktime' || contentType === 'video/x-m4v') {
    return hasIsoBaseMediaSignature(bytes);
  }
  if (contentType === 'audio/mp4') {
    return hasIsoBaseMediaSignature(bytes);
  }
  if (contentType === 'audio/wav' || contentType === 'audio/x-wav') {
    return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE';
  }
  if (contentType === 'audio/ogg') {
    return bytes.length >= 4 && ascii(bytes, 0, 4) === 'OggS';
  }
  if (contentType === 'audio/aac') {
    return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  }
  if (contentType === 'audio/mpeg') {
    return bytes.length >= 3 && (
      ascii(bytes, 0, 3) === 'ID3'
      || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    );
  }
  return false;
}

function readPrefix(chunks: Uint8Array[], maxBytes = 32): Uint8Array {
  const prefix = new Uint8Array(Math.min(
    maxBytes,
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  ));
  let offset = 0;
  for (const chunk of chunks) {
    const remaining = prefix.byteLength - offset;
    if (remaining <= 0) break;
    const slice = chunk.subarray(0, remaining);
    prefix.set(slice, offset);
    offset += slice.byteLength;
  }
  return prefix;
}

function parseContentLength(response: Response): number | null {
  const contentLengthHeader = readResponseHeader(response, 'content-length');
  if (contentLengthHeader === null) return null;

  const contentLength = Number(contentLengthHeader);
  return Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null;
}

async function openBoundedBody(
  response: Response,
  maxBytes: number,
  contentType: string,
): Promise<{ body: ReadableStream<Uint8Array>; contentLength: number | null }> {
  const contentLength = parseContentLength(response);
  if (contentLength !== null && Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RemoteMediaSecurityError('Remote media exceeds the allowed size.');
  }
  if (!response.body) {
    throw new RemoteMediaSecurityError('Remote media response has no body.');
  }

  const reader = response.body.getReader();
  const prefixChunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (totalBytes < 32) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('Remote media exceeds the allowed size.');
        throw new RemoteMediaSecurityError('Remote media exceeds the allowed size.');
      }
      prefixChunks.push(value);
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }

  if (!hasMediaSignature(readPrefix(prefixChunks), contentType)) {
    await reader.cancel('Remote media signature validation failed.').catch(() => undefined);
    reader.releaseLock();
    throw new RemoteMediaSecurityError('Remote media bytes do not match the declared content type.');
  }

  let prefixIndex = 0;
  let released = false;
  const releaseReader = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (prefixIndex < prefixChunks.length) {
          controller.enqueue(prefixChunks[prefixIndex]);
          prefixIndex += 1;
          return;
        }

        const { done, value } = await reader.read();
        if (done) {
          releaseReader();
          controller.close();
          return;
        }
        if (!value) return;

        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel('Remote media exceeds the allowed size.').catch(() => undefined);
          releaseReader();
          controller.error(new RemoteMediaSecurityError('Remote media exceeds the allowed size.'));
          return;
        }

        controller.enqueue(value);
      } catch (error) {
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      releaseReader();
    },
  });

  return { body, contentLength };
}

export function isAllowlistedRemoteMediaUrl(
  value: string,
  allowedHosts: Iterable<string> = configuredRemoteMediaHosts(),
): boolean {
  try {
    parseAndValidateRemoteUrl(value, allowedHosts);
    return true;
  } catch {
    return false;
  }
}

export async function openAllowlistedRemoteMedia({
  url: rawUrl,
  kind,
  fetcher = fetch,
  lookup = defaultLookup,
  allowedHosts = configuredRemoteMediaHosts(),
}: {
  url: string;
  kind: RemoteMediaKind;
} & RemoteMediaDownloadDependencies): Promise<AllowlistedRemoteMediaStream> {
  let url = parseAndValidateRemoteUrl(rawUrl, allowedHosts);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertPublicDns(url.hostname, lookup);
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
      headers: { Accept: `${kind}/*` },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = readResponseHeader(response, 'location');
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new RemoteMediaSecurityError('Remote media redirect could not be followed safely.');
      }
      await response.body?.cancel().catch(() => undefined);
      url = parseAndValidateRemoteUrl(new URL(location, url).toString(), allowedHosts);
      continue;
    }

    if (!response.ok) {
      throw new RemoteMediaSecurityError(`Remote media request failed with status ${response.status}.`);
    }
    const contentType = validateContentType(response, kind);
    const { body, contentLength } = await openBoundedBody(
      response,
      MAX_REMOTE_MEDIA_BYTES[kind],
      contentType,
    );
    return {
      body,
      contentLength,
      contentType,
      sourceName: url.pathname.split('/').pop() || `remote-${kind}`,
    };
  }

  throw new RemoteMediaSecurityError('Remote media redirect limit exceeded.');
}

export async function downloadAllowlistedRemoteMedia(
  params: {
    url: string;
    kind: RemoteMediaKind;
  } & RemoteMediaDownloadDependencies,
): Promise<{ blob: Blob; sourceName: string }> {
  const media = await openAllowlistedRemoteMedia(params);
  const blob = await new Response(media.body, {
    headers: { 'content-type': media.contentType },
  }).blob();
  return { blob, sourceName: media.sourceName };
}
