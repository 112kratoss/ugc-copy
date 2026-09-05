import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The read-back is retried because it is not read-after-write consistent.
 * Preview paths are content-addressed, so regenerating one upserts over an object
 * that already exists at that exact path, and the immediate read can still serve
 * the previous copy. That happened during the repair of the corrupt previews: the
 * bytes on disk were already correct, but verification read the stale object and
 * failed a preview that was in fact fine — which would burn its retry budget and
 * strand it. A first read that disagrees is therefore treated as possibly stale
 * rather than as proof of corruption; genuine corruption still fails, just after
 * a few hundred milliseconds more.
 */
const PREVIEW_READBACK_ATTEMPTS = 3;
const PREVIEW_READBACK_RETRY_MS = 250;

/** A WebP file is a RIFF container: "RIFF" at byte 0 and "WEBP" at byte 8. */
export function isDecodableWebp(bytes: Uint8Array) {
  if (bytes.length < 12) return false;

  const header = Buffer.from(bytes.subarray(0, 12));
  return header.toString('ascii', 0, 4) === 'RIFF'
    && header.toString('ascii', 8, 12) === 'WEBP';
}

/**
 * Read the object back and prove the bytes that landed are the bytes we encoded.
 *
 * An upload that "succeeds" but stores a corrupt file is worse than one that fails:
 * the caller records `preview_status: 'ready'`, and the repair job only ever revisits
 * `pending`/`failed`/`processing` — so a silently mangled preview is never retried and
 * stays broken forever. Four production previews reached exactly that state: their
 * bytes had been round-tripped through a UTF-8 decode, which replaces every byte that
 * is not valid UTF-8 with U+FFFD (`EF BF BD`). That inflates the file and shifts the
 * RIFF header, so every client fails to decode it while the row still claims success.
 *
 * Compare the entire payload, since a same-length damaged WebP can retain its
 * RIFF signature. The generation writer already read back its upload. Post writers add one
 * small preview read on success, with at most three reads on a mismatch.
 * Throwing converts permanent silent breakage into an ordinary retry.
 */
export async function assertStoredPreviewIsIntact({
  supabase,
  location,
  expected,
}: {
  supabase: SupabaseClient;
  location: { bucket: string; filePath: string };
  expected: Buffer;
}) {
  let mismatch = '';

  for (let attempt = 1; attempt <= PREVIEW_READBACK_ATTEMPTS; attempt += 1) {
    const stored = await supabase.storage.from(location.bucket).download(location.filePath);

    if (stored.error || !stored.data) {
      throw stored.error ?? new Error(`Preview ${location.filePath} could not be read back after upload`);
    }

    const bytes = new Uint8Array(await stored.data.arrayBuffer());
    if (Buffer.from(bytes).equals(expected) && isDecodableWebp(bytes)) return;

    mismatch = bytes.length === expected.length
      ? isDecodableWebp(bytes)
        ? 'does not match the encoded preview after upload'
        : 'is not a decodable WebP after upload'
      : `stored ${bytes.length} bytes but ${expected.length} were encoded`;

    if (attempt < PREVIEW_READBACK_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, PREVIEW_READBACK_RETRY_MS));
    }
  }

  throw new Error(`Preview ${location.filePath} ${mismatch}`);
}
