/**
 * Browser-side requests for the owner lifecycle of a post: visibility,
 * archive, restore, delete.
 *
 * Every owner surface (Studio's Post Library and Creations cards, the
 * showcase detail page) used to carry its own copy of these calls, and the
 * copies disagreed on which endpoint a generation-backed post goes through.
 * This module is the one place that knows: the post route, for every post,
 * the same door the mobile app uses.
 */

export type PostVisibility = 'public' | 'unlisted' | 'private';

export interface PostLifecycleRequestTarget {
  id: string;
  /**
   * Kept on the target so surfaces can pass their post records through
   * unchanged; the lifecycle no longer branches on it. Every post, made from a
   * creation or uploaded, changes visibility through the post route, which
   * moves a creation's media between its public and private copies itself.
   */
  generationId: string | null;
}

export interface PostVisibilityChangeResult {
  visibility: PostVisibility;
  ownerPath: string | null;
  showcasePath: string | null;
  resourceBundleStatus: 'draft' | 'published' | null;
}

export type PostDeleteResult =
  | { deleted: true; tombstoned: boolean }
  /**
   * The post has paid buyers. The server refuses a plain delete so the owner
   * can choose archive instead; retry with `force: true` to delete anyway.
   */
  | { deleted: false; requiresForceDelete: true };

export class PostLifecycleRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, options: { status: number; code?: string | null }) {
    super(message);
    this.name = 'PostLifecycleRequestError';
    this.status = options.status;
    this.code = options.code ?? null;
  }
}

type FetchLike = typeof fetch;

interface RequestOptions {
  accessToken: string;
  fetchImpl?: FetchLike;
}

type JsonRecord = Record<string, unknown>;

async function readJson(response: Response): Promise<JsonRecord> {
  try {
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === 'object' ? (parsed as JsonRecord) : {};
  } catch {
    return {};
  }
}

function readString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value ? value : null;
}

function buildHeaders(accessToken: string, withBody: boolean): HeadersInit {
  return {
    ...(withBody ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${accessToken}`,
  };
}

async function sendLifecycleRequest(
  input: string,
  init: RequestInit,
  fallbackError: string,
  fetchImpl: FetchLike,
): Promise<{ response: Response; data: JsonRecord }> {
  const response = await fetchImpl(input, init);
  const data = await readJson(response);
  if (!response.ok || data.success !== true) {
    throw new PostLifecycleRequestError(readString(data, 'error') ?? fallbackError, {
      status: response.status,
      code: readString(data, 'code'),
    });
  }
  return { response, data };
}

export async function requestPostVisibilityChange({
  post,
  visibility,
  accessToken,
  fetchImpl = fetch,
}: RequestOptions & {
  post: PostLifecycleRequestTarget;
  visibility: PostVisibility;
}): Promise<PostVisibilityChangeResult> {
  const { data } = await sendLifecycleRequest(
    `/api/posts/${post.id}`,
    {
      method: 'PUT',
      headers: buildHeaders(accessToken, true),
      body: JSON.stringify({ visibility }),
    },
    'Failed to update post visibility.',
    fetchImpl,
  );

  const returnedVisibility = data.visibility;
  const resourceBundleStatus = data.resourceBundleStatus;

  return {
    visibility:
      returnedVisibility === 'public' || returnedVisibility === 'unlisted' || returnedVisibility === 'private'
        ? returnedVisibility
        : visibility,
    ownerPath: readString(data, 'ownerPath'),
    showcasePath: readString(data, 'showcasePath'),
    resourceBundleStatus:
      resourceBundleStatus === 'draft' || resourceBundleStatus === 'published' ? resourceBundleStatus : null,
  };
}

export async function requestPostArchive({
  postId,
  accessToken,
  fetchImpl = fetch,
}: RequestOptions & { postId: string }): Promise<void> {
  await sendLifecycleRequest(
    `/api/posts/${postId}/archive`,
    { method: 'POST', headers: buildHeaders(accessToken, false) },
    'Failed to archive post.',
    fetchImpl,
  );
}

export async function requestPostRestore({
  postId,
  accessToken,
  fetchImpl = fetch,
}: RequestOptions & { postId: string }): Promise<void> {
  await sendLifecycleRequest(
    `/api/posts/${postId}/restore`,
    { method: 'POST', headers: buildHeaders(accessToken, false) },
    'Failed to restore post.',
    fetchImpl,
  );
}

export async function requestPostDelete({
  postId,
  accessToken,
  force = false,
  fetchImpl = fetch,
}: RequestOptions & { postId: string; force?: boolean }): Promise<PostDeleteResult> {
  const response = await fetchImpl(`/api/posts/${postId}`, {
    method: 'DELETE',
    headers: buildHeaders(accessToken, true),
    body: JSON.stringify({ force }),
  });
  const data = await readJson(response);

  if (response.status === 409 && data.requiresForceDelete === true) {
    return { deleted: false, requiresForceDelete: true };
  }

  if (!response.ok || data.success !== true) {
    throw new PostLifecycleRequestError(readString(data, 'error') ?? 'Failed to delete post.', {
      status: response.status,
      code: readString(data, 'code'),
    });
  }

  return { deleted: true, tombstoned: data.tombstoned === true };
}
