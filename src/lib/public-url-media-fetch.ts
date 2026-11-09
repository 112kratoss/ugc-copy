import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

import {
  canonicalStorageMediaMimeType,
  isAllowedStorageMediaMimeType,
  type StorageMediaKind,
} from '@/lib/storage-upload-mime-policy';

/**
 * Fetches media from a public https URL an agent named, for `upload_input`, without becoming a
 * way to read this server's own network.
 *
 * The URL an agent sends is the agent's word for where a file is, and a server that fetches
 * whatever it is told reaches the places a browser cannot: the cloud's metadata service, the
 * database, a sibling function, a printer in an office. So before any byte is read the host is
 * resolved and every address it resolves to must be public unicast (no loopback, private, link-
 * local, carrier-grade NAT, multicast, reserved or documentation range, in IPv4 or in IPv6 with
 * its mapped, NAT64, 6to4 and Teredo embeddings), and the connection is then made to those exact
 * addresses (a `lookup` pinned to the resolved list), so a name that answers one address to the
 * check and another to the connection (DNS rebinding) gains nothing. A redirect is followed once,
 * to the same host over https, and its target is resolved and checked again before it is fetched.
 *
 * What comes back is held to the storage MIME policy by its `Content-Type` (never by the URL's
 * extension, which says nothing about the bytes), to the byte cap of its kind by `Content-Length`
 * and again as the body streams (a server may lie about the length or send none), and to the
 * first bytes: a picture must carry a picture's signature (every listed picture type has one), so
 * a page or random bytes served as a picture are refused rather than staged; a clip or a track is
 * refused only when its bytes say another kind, since several audio and video containers have no
 * fixed signature.
 */

export type PublicMediaFetchRefusalCode =
  | 'INVALID_URL'
  | 'PRIVATE_ADDRESS'
  | 'UNRESOLVABLE_HOST'
  | 'REDIRECT_REFUSED'
  | 'HTTP_ERROR'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_MEDIA'
  | 'TIMEOUT'
  | 'NETWORK_ERROR';

export type PublicMediaFetchResult =
  | {
      ok: true;
      bytes: Buffer;
      contentType: string;
      kind: StorageMediaKind;
      /** The URL the bytes came from: the one given, or the one redirect it allowed. */
      finalUrl: string;
    }
  | {
      ok: false;
      code: PublicMediaFetchRefusalCode;
      message: string;
      details?: Record<string, unknown>;
    };

export type HostLookup = (hostname: string) => Promise<string[]>;

export type PublicMediaFetchOptions = {
  /** The most bytes a file of each kind may be; the kind is read from the response's type. */
  maxBytesByKind: Record<StorageMediaKind, number>;
  /** The whole fetch, redirect included, gives up after this. */
  timeoutMs?: number;
  /** Resolves a host to its addresses; the system resolver unless a test supplies one. */
  lookup?: HostLookup;
  /** Opens the connection; `https.request` unless a test supplies one. */
  request?: typeof https.request;
};

export const PUBLIC_MEDIA_FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 1;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = 'Magicbooklet-MCP/1.0 (+https://magicbooklet.com)';

/**
 * Names that are never public whatever they resolve to. The address check below catches what they
 * resolve to as well; this keeps a name a resolver might answer oddly from reaching it.
 */
const PRIVATE_HOST_SUFFIXES = ['localhost', 'local', 'internal', 'arpa', 'test', 'invalid', 'example'];

/** Every address range that is not public unicast; an address in one of these is refused. */
const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, the cloud metadata services among them
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::', 96], // IPv4-compatible (deprecated); mapped addresses are checked as IPv4 by the BlockList
  ['64:ff9b::', 96], // NAT64, an IPv4 address embedded
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo, an IPv4 address embedded
  ['2001:2::', 48], // benchmarking
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4, an IPv4 address embedded
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, 'ipv6');
}

/** Whether an IP address is public unicast: not loopback, private, link-local, multicast or reserved. */
export function isPublicUnicastAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (PRIVATE_RANGES.check(address, family === 6 ? 'ipv6' : 'ipv4')) return false;
  if (family === 6) {
    // An IPv4 address carried inside an IPv6 one is judged as that IPv4 address too.
    const embedded = embeddedIpv4(address);
    if (embedded && !isPublicUnicastAddress(embedded)) return false;
  }
  return true;
}

/** The IPv4 address an IPv6 mapped (`::ffff:a.b.c.d`) address carries, or null. */
function embeddedIpv4(address: string): string | null {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  if (mapped) return mapped[1];
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(address);
  if (hexMapped) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return null;
}

function isPrivateHostname(hostname: string): boolean {
  const labels = hostname.toLowerCase().split('.').filter(Boolean);
  const last = labels[labels.length - 1];
  return labels.length === 0 || PRIVATE_HOST_SUFFIXES.includes(last);
}

async function systemLookup(hostname: string): Promise<string[]> {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

/**
 * The addresses a URL's host may be connected to: every address it resolves to, each public
 * unicast. A host with one private address among its answers is refused whole, since the
 * connection could land on any of them.
 */
export async function resolvePublicHost(
  hostname: string,
  lookup: HostLookup = systemLookup,
): Promise<{ ok: true; addresses: string[] } | Extract<PublicMediaFetchResult, { ok: false }>> {
  const bare = hostname.replace(/^\[|\]$/gu, '');
  if (isIP(bare)) {
    return isPublicUnicastAddress(bare)
      ? { ok: true, addresses: [bare] }
      : { ok: false, code: 'PRIVATE_ADDRESS', message: `${bare} is not a public address.`, details: { host: hostname } };
  }
  if (isPrivateHostname(bare)) {
    return { ok: false, code: 'PRIVATE_ADDRESS', message: `${hostname} is not a public host.`, details: { host: hostname } };
  }
  let addresses: string[];
  try {
    addresses = await lookup(bare);
  } catch {
    return { ok: false, code: 'UNRESOLVABLE_HOST', message: `${hostname} could not be resolved.`, details: { host: hostname } };
  }
  if (addresses.length === 0) {
    return { ok: false, code: 'UNRESOLVABLE_HOST', message: `${hostname} resolves to no address.`, details: { host: hostname } };
  }
  const refused = addresses.find((address) => !isPublicUnicastAddress(address));
  if (refused) {
    return {
      ok: false,
      code: 'PRIVATE_ADDRESS',
      message: `${hostname} resolves to a private or reserved address, which this server does not fetch from.`,
      details: { host: hostname },
    };
  }
  return { ok: true, addresses };
}

/** The URL as the fetch takes it: https, a host, no credentials, the default port. */
export function parsePublicMediaUrl(value: string): { ok: true; url: URL } | Extract<PublicMediaFetchResult, { ok: false }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, code: 'INVALID_URL', message: 'The url is not a valid absolute URL.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, code: 'INVALID_URL', message: 'Only https URLs are fetched.' };
  }
  if (url.username || url.password) {
    return { ok: false, code: 'INVALID_URL', message: 'A URL with credentials is refused.' };
  }
  if (url.port && url.port !== '443') {
    return { ok: false, code: 'INVALID_URL', message: 'Only the default https port is fetched.' };
  }
  if (!url.hostname) {
    return { ok: false, code: 'INVALID_URL', message: 'The url names no host.' };
  }
  return { ok: true, url };
}

type Signature = { kind: StorageMediaKind; test: (bytes: Buffer) => boolean };

const ascii = (bytes: Buffer, start: number, text: string) => bytes.toString('latin1', start, start + text.length) === text;
const ISO_BMFF_IMAGE_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);
const ISO_BMFF_AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ']);

/**
 * The format the first bytes say a file is, where the format has a signature: a kind, since that is
 * what the storage policy and the caps are keyed on. Null for a format with none, or one not listed.
 */
export function sniffMediaKind(bytes: Buffer): StorageMediaKind | null {
  if (bytes.length < 12) return null;
  const signatures: Signature[] = [
    { kind: 'image', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }, // JPEG
    { kind: 'image', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }, // PNG
    { kind: 'image', test: (b) => ascii(b, 0, 'GIF8') }, // GIF
    { kind: 'image', test: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP') }, // WebP
    { kind: 'audio', test: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE') }, // WAV
    { kind: 'audio', test: (b) => ascii(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe6) === 0xe2) }, // MP3 (an ID3 tag or a frame sync)
    { kind: 'audio', test: (b) => ascii(b, 0, 'OggS') }, // Ogg
    { kind: 'video', test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 }, // Matroska and WebM
  ];
  for (const signature of signatures) {
    if (signature.test(bytes)) return signature.kind;
  }
  if (ascii(bytes, 4, 'ftyp')) {
    // ISO base media: HEIC and AVIF pictures, M4A tracks, and every other brand a movie.
    const brand = bytes.toString('latin1', 8, 12);
    if (ISO_BMFF_IMAGE_BRANDS.has(brand)) return 'image';
    if (ISO_BMFF_AUDIO_BRANDS.has(brand)) return 'audio';
    return 'video';
  }
  return null;
}

/** The kind a MIME type names, by its top-level type; null for one outside image, video and audio. */
export function mediaKindOfMimeType(mimeType: string): StorageMediaKind | null {
  const type = mimeType.split('/')[0];
  return type === 'image' || type === 'video' || type === 'audio' ? type : null;
}

/** The media type of a `Content-Type` header, parameters dropped, as the storage policy names it. */
export function canonicalContentType(header: string | undefined): string {
  return canonicalStorageMediaMimeType((header ?? '').split(';')[0].trim());
}

/** Builds the `lookup` a connection uses: the addresses already checked, and nothing else. */
function pinnedLookup(addresses: string[]): NonNullable<https.RequestOptions['lookup']> {
  const pinned = addresses.map((address) => ({ address, family: isIP(address) }));
  return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    if (wantsAll) {
      callback(null, pinned);
    } else {
      callback(null, pinned[0].address, pinned[0].family);
    }
  }) as unknown as NonNullable<https.RequestOptions['lookup']>;
}

type HopResult =
  | { kind: 'redirect'; location: string }
  | { kind: 'body'; bytes: Buffer; contentType: string; mediaKind: StorageMediaKind }
  | Extract<PublicMediaFetchResult, { ok: false }>;

function fetchHop(
  url: URL,
  addresses: string[],
  options: Required<Pick<PublicMediaFetchOptions, 'maxBytesByKind' | 'request'>> & { deadline: number },
): Promise<HopResult> {
  return new Promise((resolve) => {
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) {
      resolve({ ok: false, code: 'TIMEOUT', message: 'The fetch took too long.' });
      return;
    }
    let settled = false;
    const finish = (result: HopResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const request = options.request(url, {
      method: 'GET',
      lookup: pinnedLookup(addresses),
      headers: {
        accept: 'image/*,video/*,audio/*;q=0.9,*/*;q=0.1',
        'user-agent': USER_AGENT,
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status)) {
        const location = response.headers.location;
        response.resume();
        finish(typeof location === 'string' && location
          ? { kind: 'redirect', location }
          : { ok: false, code: 'REDIRECT_REFUSED', message: 'The server redirected without saying where.' });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        finish({ ok: false, code: 'HTTP_ERROR', message: `The server answered ${status}.`, details: { status } });
        return;
      }
      const contentType = canonicalContentType(response.headers['content-type']);
      const mediaKind = mediaKindOfMimeType(contentType);
      if (!mediaKind || !isAllowedStorageMediaMimeType(mediaKind, contentType)) {
        response.resume();
        finish({
          ok: false,
          code: 'UNSUPPORTED_MEDIA',
          message: `The server sent ${contentType || 'no media type'}, which is not a picture, clip or track type Magicbooklet takes.`,
          details: { content_type: contentType || null },
        });
        return;
      }
      const cap = options.maxBytesByKind[mediaKind];
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > cap) {
        response.resume();
        finish({ ok: false, code: 'TOO_LARGE', message: `The file is ${declared} bytes; a ${mediaKind} may be at most ${cap}.`, details: { bytes: declared, max_bytes: cap } });
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > cap) {
          request.destroy();
          finish({ ok: false, code: 'TOO_LARGE', message: `The file is larger than ${cap} bytes, the most a ${mediaKind} may be.`, details: { max_bytes: cap } });
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish({ kind: 'body', bytes: Buffer.concat(chunks), contentType, mediaKind }));
      response.on('error', (error: Error) => finish({ ok: false, code: 'NETWORK_ERROR', message: `The download failed: ${error.message}` }));
    });
    const timer = setTimeout(() => {
      request.destroy();
      finish({ ok: false, code: 'TIMEOUT', message: 'The fetch took too long.' });
    }, remaining);
    request.on('error', (error: Error) => finish({ ok: false, code: 'NETWORK_ERROR', message: `The connection failed: ${error.message}` }));
    request.end();
  });
}

/**
 * Fetches the media at a public https URL under the rules above. The answer is the bytes with
 * their type and kind, or a refusal whose code names which rule refused.
 */
export async function fetchPublicHttpsMedia(value: string, options: PublicMediaFetchOptions): Promise<PublicMediaFetchResult> {
  const request = options.request ?? https.request;
  const lookup = options.lookup ?? systemLookup;
  const deadline = Date.now() + (options.timeoutMs ?? PUBLIC_MEDIA_FETCH_TIMEOUT_MS);

  const parsed = parsePublicMediaUrl(value);
  if (!parsed.ok) return parsed;
  let url = parsed.url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const resolved = await resolvePublicHost(url.hostname, lookup);
    if (!resolved.ok) return resolved;
    const result = await fetchHop(url, resolved.addresses, { maxBytesByKind: options.maxBytesByKind, request, deadline });
    if ('ok' in result) return result;
    if (result.kind === 'body') {
      const sniffed = sniffMediaKind(result.bytes);
      const mismatch = result.mediaKind === 'image' ? sniffed !== 'image' : sniffed !== null && sniffed !== result.mediaKind;
      if (mismatch) {
        return {
          ok: false,
          code: 'UNSUPPORTED_MEDIA',
          message: sniffed
            ? `The server called the file ${result.contentType}, but its bytes are a ${sniffed}.`
            : `The server called the file ${result.contentType}, but its bytes are not a picture of a type Magicbooklet takes.`,
          details: { content_type: result.contentType, sniffed_kind: sniffed },
        };
      }
      return { ok: true, bytes: result.bytes, contentType: result.contentType, kind: result.mediaKind, finalUrl: url.toString() };
    }
    if (hop === MAX_REDIRECTS) {
      return { ok: false, code: 'REDIRECT_REFUSED', message: 'The server redirected more than once; give the file\'s final URL.' };
    }
    let next: URL;
    try {
      next = new URL(result.location, url);
    } catch {
      return { ok: false, code: 'REDIRECT_REFUSED', message: 'The server redirected to an invalid address.' };
    }
    const nextParsed = parsePublicMediaUrl(next.toString());
    if (!nextParsed.ok) return { ok: false, code: 'REDIRECT_REFUSED', message: `The redirect was refused: ${nextParsed.message}` };
    if (nextParsed.url.hostname.toLowerCase() !== url.hostname.toLowerCase()) {
      return {
        ok: false,
        code: 'REDIRECT_REFUSED',
        message: `The server redirected to ${nextParsed.url.hostname}; a redirect is followed only on the same host. Give the file's final URL.`,
        details: { redirect_host: nextParsed.url.hostname },
      };
    }
    url = nextParsed.url;
  }
  return { ok: false, code: 'REDIRECT_REFUSED', message: 'The server redirected more than once.' };
}
