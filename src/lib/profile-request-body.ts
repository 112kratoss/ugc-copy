import { readBoundedJsonBody, type BoundedJsonBodyResult } from '@/lib/bounded-json-request';

// Profile JSON contains text and upload metadata, never image bytes. Keep room
// for escaped text and URLs while bounding unknown fields and whitespace too.
export const PROFILE_REQUEST_BODY_MAX_BYTES = 64 * 1024;
export const PROFILE_REQUEST_TOO_LARGE = 'Profile request is too large.';

export async function readProfileJsonBody(request: Request): Promise<BoundedJsonBodyResult> {
  try {
    return await readBoundedJsonBody(request, PROFILE_REQUEST_BODY_MAX_BYTES);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}
