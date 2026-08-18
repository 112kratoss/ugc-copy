import 'server-only';

/**
 * Wrap encoded bytes for Supabase Storage. Always upload a Blob, never a Buffer.
 *
 * `StorageFileApi.uploadOrUpdate` branches on the body type: a Blob is appended to
 * a FormData and sent as multipart, while anything it does not recognise — a Node
 * Buffer included — falls through to a generic raw-body path where the bytes are
 * UTF-8 stringified in transit. Every byte that is not valid UTF-8 becomes U+FFFD
 * (`EF BF BD`), which inflates the payload about 1.8x and destroys the file.
 *
 * This was not theoretical. Four stored previews were corrupted exactly this way —
 * a 79,616 byte WebP landed as 144,323 bytes with the replacement character sitting
 * inside its RIFF header, undecodable on every client, while the upload reported
 * success. Generation *outputs* never corrupted because they stream from disk
 * rather than passing a Buffer, which is what isolated the difference.
 *
 * Passing the content type here also keeps the stored object's MIME type correct,
 * which the raw-body path does not guarantee.
 */
export function toStorageUploadBody(bytes: Buffer | Uint8Array, contentType: string): Blob {
  // Copy into a plain Uint8Array so a Buffer's identity cannot leak through to the
  // client's type check, and so the Blob never aliases a pooled Buffer's memory.
  return new Blob([new Uint8Array(bytes)], { type: contentType });
}
