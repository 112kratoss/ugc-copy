import { ApiError } from './api-client';
import type { CreatePostResponse } from './types';

/**
 * The key a composed post is created under (`Idempotency-Key` on `POST /api/posts`,
 * `createPost.idempotency` in `contracts/mobile-api-v1.json`). The server derives the new post's id
 * from the account and the key and answers a repeat with the post it already made, so a publish
 * whose answer was lost and is pressed again does not make a second post (audit 2026-11-27,
 * finding 4).
 *
 * One key per composed post: the composer makes it at the first create and keeps it across every
 * failed attempt; a new post starts with a new one.
 */
export const POST_CREATE_KEY_CONFLICT_CODE = 'IDEMPOTENCY_KEY_CONFLICT';
export const POST_CREATE_IN_PROGRESS_CODE = 'POST_CREATE_IN_PROGRESS';
export const POST_SAVED_AS_DRAFT_CODE = 'POST_SAVED_AS_DRAFT';

/**
 * The post a 409 `POST_SAVED_AS_DRAFT` carries, as a create's answer: the post exists as a private
 * draft, so the composer finishes the publish as a draft rather than create again under a new key.
 * Null for any other failure, or a body without the post.
 */
export function readSavedAsDraft(error: unknown): CreatePostResponse | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== POST_SAVED_AS_DRAFT_CODE) return null;
  const details = (typeof error.details === 'object' && error.details !== null ? error.details : {}) as Record<string, unknown>;
  if (typeof details.postId !== 'string' || details.postId.length === 0) return null;
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    success: true,
    postId: details.postId,
    visibility: 'private',
    showcasePath: null,
    ownerPath: text(details.ownerPath),
    resourceBundlePath: text(details.resourceBundlePath),
    message: error.message,
    savedAsDraft: true,
  };
}

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
 * The key the next attempt goes under, by the contract's rule (shared with the web composer): kept
 * where the server may have made the post or is making it (a network failure, a 5xx,
 * `POST_CREATE_IN_PROGRESS`) and on a rate limit; replaced on `IDEMPOTENCY_KEY_CONFLICT` and on any
 * other 4xx, where the request was read and made nothing.
 */
export function postCreateKeyAfterFailure(key: string, error: unknown): string {
  if (!(error instanceof ApiError)) return key;
  if (error.status === 409 && error.code === POST_CREATE_KEY_CONFLICT_CODE) return createPostCreateKey();
  if (error.status === 429 || error.code === POST_CREATE_IN_PROGRESS_CODE) return key;
  if (error.status >= 400 && error.status < 500) return createPostCreateKey();
  return key;
}
