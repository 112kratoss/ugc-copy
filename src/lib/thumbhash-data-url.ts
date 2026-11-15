import { thumbHashToDataURL } from 'thumbhash';

/**
 * A server's preview thumbhash (base64, as `previewThumbhash` and a search
 * row's `thumbnail.thumbhash` carry it) as a data URL to draw under the
 * picture while it loads. Null for none, or for one that cannot be read: the
 * frame's own fill stands in.
 */
export function thumbhashDataUrl(hash: string | null | undefined): string | null {
  if (!hash || typeof atob !== 'function') return null;
  try {
    const binary = atob(hash);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return thumbHashToDataURL(bytes);
  } catch {
    return null;
  }
}
