import { replaceEqualDeep } from '@tanstack/react-query';

import { env } from './env';
import { preserveStableSignedUrl } from './template-run-stable-media';

/**
 * Every read of a profile library signs its files again: the owner list signs
 * each creation's original, preview and display rendition for an hour on every
 * request (`createSignedUrls` in `src/lib/owned-media-url-batch.ts`), so a
 * refresh brings each creation back with new addresses for the same files. A
 * picture is drawn from its address, and a new address starts it over:
 * `StableMediaImage` mounts a fresh native image for it, which shows blank,
 * then the thumbhash, then the picture again from the cache — what the card a
 * Creations tile opened did about 1.3 s after it landed on the Pixel 9a
 * emulator, with nothing touched (2026-11-03). The card feed reads the
 * library's first page again as it opens on a library over a minute old, and
 * the Profile grid does on focus, on return to the app and every 15 s while a
 * run renders, each time for every picture on that page.
 *
 * So a write to a library keeps the address the library already holds for the
 * same file while that address has more than five minutes to live — the rule a
 * template run's reads follow, here and on the web (`preserveStableSignedUrl`)
 * — and takes the incoming one for a different file, for an address it cannot
 * date, and near the end of the held one. Nothing else in the read is changed.
 *
 * `next` is walked beside `previous`: records key by key, and arrays element by
 * element. An element with an `id` is matched with the element of that id held
 * under the same key anywhere in `previous`, so a creation that moved to
 * another page keeps its addresses; any other element is matched by position.
 * However an element is matched, an address is only ever exchanged for one the
 * library held that differs from it in nothing but its signature.
 */
export function preserveStableLibraryMedia<T>(
  previous: unknown,
  next: T,
  nowMs = Date.now(),
  storageBaseUrl: string = env.supabaseUrl,
): T {
  if (previous === undefined || previous === null || previous === next) return next;
  const signedPrefix = signedAddressPrefix(storageBaseUrl);
  if (!signedPrefix) return next;
  return keepHeldAddresses(previous, next, '', { previous, held: null, signedPrefix, nowMs, storageBaseUrl }) as T;
}

/**
 * The libraries' `structuralSharing` (`PROFILE_LIBRARY_QUERY_BEHAVIOUR`), so
 * every write keeps the held addresses: a fetch, a refetch, a page loaded
 * more, and `setQueryData`, which is how a first page read again is merged
 * (`refreshProfileLibraryHead`). React Query's own sharing then runs over the
 * result, so a read that only signed the files again leaves the library's data
 * as it was and nothing draws again.
 */
export function keepLibraryMediaAddresses(previous: unknown, next: unknown): unknown {
  return replaceEqualDeep(previous, preserveStableLibraryMedia(previous, next));
}

type Walk = {
  /** The read before, whole. */
  previous: unknown;
  /** Its elements with an id, by array key and id; built the first time an element is not where it was. */
  held: Map<string, unknown> | null;
  /** How this project's signed Storage addresses begin. */
  signedPrefix: string;
  nowMs: number;
  storageBaseUrl: string;
};

type Fields = Record<string, unknown>;

function signedAddressPrefix(storageBaseUrl: string): string | null {
  try {
    return `${new URL(storageBaseUrl).origin}/storage/v1/object/sign/`;
  } catch {
    return null;
  }
}

/** Whether two addresses are this project's signed addresses for one file, asked for the same way. */
function onlySignatureDiffers(previous: string, next: string, walk: Walk) {
  return previous.startsWith(walk.signedPrefix)
    && next.startsWith(walk.signedPrefix)
    && !/\s/.test(previous)
    && !/\s/.test(next)
    && withoutSignature(previous) === withoutSignature(next);
}

function withoutSignature(address: string) {
  const query = address.indexOf('?');
  if (query === -1) return address;
  const params = address.slice(query + 1).split('&').filter((param) => !param.startsWith('token='));
  return `${address.slice(0, query)}?${params.join('&')}`;
}

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idOf(value: unknown): string | null {
  return isFields(value) && typeof value.id === 'string' ? value.id : null;
}

function heldKey(arrayKey: string, id: string) {
  return `${arrayKey}\n${id}`;
}

/** The element the read before held with this id under this key, wherever it sat. */
function heldElement(walk: Walk, arrayKey: string, id: string): unknown {
  if (!walk.held) {
    walk.held = new Map();
    indexHeldElements(walk.previous, '', walk.held);
  }
  return walk.held.get(heldKey(arrayKey, id));
}

/** Every element with an id that `value` holds in an array, under the key the array sits under. */
function indexHeldElements(value: unknown, key: string, held: Map<string, unknown>) {
  if (Array.isArray(value)) {
    for (const element of value) {
      const id = idOf(element);
      if (id !== null && !held.has(heldKey(key, id))) held.set(heldKey(key, id), element);
      indexHeldElements(element, key, held);
    }
    return;
  }
  if (isFields(value)) {
    for (const [childKey, child] of Object.entries(value)) indexHeldElements(child, childKey, held);
  }
}

function keepHeldAddresses(previous: unknown, next: unknown, key: string, walk: Walk): unknown {
  if (previous === next) return next;
  if (typeof next === 'string') {
    return typeof previous === 'string' && onlySignatureDiffers(previous, next, walk)
      ? preserveStableSignedUrl(previous, next, walk.nowMs, walk.storageBaseUrl) ?? next
      : next;
  }
  if (Array.isArray(next)) {
    const heldElements: unknown[] = Array.isArray(previous) ? previous : [];
    let changed = false;
    const kept = next.map((element: unknown, position) => {
      const id = idOf(element);
      const atPosition = heldElements[position];
      const counterpart = id === null || idOf(atPosition) === id ? atPosition : heldElement(walk, key, id);
      const result = keepHeldAddresses(counterpart, element, key, walk);
      if (result !== element) changed = true;
      return result;
    });
    return changed ? kept : next;
  }
  if (isFields(next) && isFields(previous)) {
    let changed = false;
    let keptOwnAddress = false;
    const kept: Fields = {};
    for (const [childKey, child] of Object.entries(next)) {
      const result = keepHeldAddresses(previous[childKey], child, childKey, walk);
      if (result !== child) {
        changed = true;
        if (typeof child === 'string') keptOwnAddress = true;
      }
      kept[childKey] = result;
    }
    if (!changed) return next;
    // A media descriptor's `expiresAt` dates the addresses beside it. One that
    // kept an address from the read before keeps that read's date as well,
    // which is no later than the kept address's own end.
    if (keptOwnAddress && 'expiresAt' in next && 'expiresAt' in previous) kept.expiresAt = previous.expiresAt;
    return kept;
  }
  return next;
}
