import { ApiError } from './api-client';

/**
 * The key a composed post is created under (`Idempotency-Key` on `POST /api/posts`,
 * `createPost.idempotency` in `contracts/mobile-api-v1.json`). The server takes it as the new
 * post's id and answers a repeat with the post it already made, so a publish whose answer was
 * lost and is pressed again does not make a second post (audit 2026-11-27, finding 4).
 *
 * One key per composed post: the composer makes it at the first create and keeps it across every
 * failed attempt; a new post starts with a new one.
 */
export const POST_CREATE_KEY_CONFLICT_CODE = 'IDEMPOTENCY_KEY_CONFLICT';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function randomUuidV4(): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createPostCreateKey(
  randomUUID: (() => string) | undefined = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
): string {
  const candidate = randomUUID?.().toLowerCase();
  return candidate && UUID_V4.test(candidate) ? candidate : randomUuidV4();
}

/**
 * The key the next attempt goes under. It stays the same after any failure, the server having
 * perhaps made the post, except where the server says the key cannot make this post (another
 * account's id, a post deleted since, or one a failed save left unfinished): then a new one.
 */
export function postCreateKeyAfterFailure(key: string, error: unknown): string {
  if (error instanceof ApiError && error.status === 409 && error.code === POST_CREATE_KEY_CONFLICT_CODE) {
    return createPostCreateKey();
  }
  return key;
}
