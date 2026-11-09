import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import {
  canonicalContentType,
  fetchPublicHttpsMedia,
  mediaKindOfMimeType,
  sniffMediaKind,
  type PublicMediaFetchRefusalCode,
} from '@/lib/public-url-media-fetch';
import { SHOWCASE_PUBLIC_MEDIA_CACHE_TTL_SECONDS } from '@/lib/showcase-media-cache';
import { resolveSignedUploadUrl } from '@/lib/signed-url-upload';
import { parseCanonicalStorageLocation } from '@/lib/storage-ownership';
import {
  canonicalStorageMediaMimeType,
  isAllowedStorageMediaMimeType,
  type StorageMediaKind,
} from '@/lib/storage-upload-mime-policy';
import { createTemporaryMediaReadUrl } from '@/lib/temporary-media-read-url';
import {
  MAX_UPLOAD_BYTES_BY_KIND,
  createTemporaryMediaUploadIntent,
} from '@/lib/temporary-media-upload-sign';
import {
  UPLOAD_RESERVATIONS_TABLE,
  deleteReservedObjectAndConfirm,
  finalizeUploadById,
  type UploadFinalizationResult,
  type UploadReservationRow,
} from '@/lib/upload-finalization';

/**
 * Stages a file an agent sends, for a run or for a post, the way the web's creators stage one:
 * the sign step reserves the bytes and records the intent, the bytes go up under the type the
 * sign step kept, finalize checks the stored object against what was declared, and a signed read
 * URL is minted for the hour. Because it is the same staging path, the reclaim sweep collects an
 * upload nothing ever used and the byte reservations count it like any other
 * (`upload-finalization.ts`, `upload-byte-admission.ts`).
 *
 * The bytes come from one of three places. A public https URL, which this server fetches
 * (`public-url-media-fetch.ts` decides what public means and holds the download to the caps). A
 * base64 string, which is bounded far lower: a tool argument travels through the MCP request
 * body, which Vercel caps at 4.5 MB, so 3 MB decoded (4 MB encoded, with room for the JSON-RPC
 * envelope) is the most that reaches the route. Or the agent's own machine: `requestAgentUpload`
 * signs an upload the agent PUTs the file to itself (a local file never has to pass through a
 * tool argument), and the `uploadId` source then finalizes it and holds its first bytes to the
 * signature rule the other two apply to bytes they hold.
 */

const STAGING_BUCKET = 'uploads';

/** A kind as a sentence names it. */
const KIND_NOUN: Record<StorageMediaKind, string> = { image: 'a picture', video: 'a clip', audio: 'a track' };

export const AGENT_BASE64_MAX_BYTES = 3 * 1024 * 1024;
/** The most characters the base64 argument may be: the cap encoded, with padding and whitespace room. */
export const AGENT_BASE64_MAX_CHARACTERS = Math.ceil(AGENT_BASE64_MAX_BYTES / 3) * 4 + 64;
/** Vercel's request body limit for a function: everything above must fit under it with the envelope. */
export const VERCEL_REQUEST_BODY_LIMIT_BYTES = 4.5 * 1024 * 1024;

/**
 * What a URL fetch may be, by kind: below the sign step's own caps (`MAX_UPLOAD_BYTES_BY_KIND`,
 * 250 MB for a clip), because the whole file is buffered in the function before it is stored and
 * the fetch, the store, finalize and the read URL must all fit in the route's 60 seconds. A
 * picture keeps the sign step's 25 MB; a clip or a track takes 50 MB.
 */
export const AGENT_URL_FETCH_MAX_BYTES_BY_KIND: Record<StorageMediaKind, number> = {
  image: Math.min(MAX_UPLOAD_BYTES_BY_KIND.image, 25 * 1024 * 1024),
  video: Math.min(MAX_UPLOAD_BYTES_BY_KIND.video, 50 * 1024 * 1024),
  audio: Math.min(MAX_UPLOAD_BYTES_BY_KIND.audio, 50 * 1024 * 1024),
};

export type AgentInputSource =
  | { url: string }
  | { base64: string; mimeType: string }
  /** An upload `requestAgentUpload` signed, once the agent has PUT the file to it. */
  | { uploadId: string };

export type AgentInputUploadRefusalCode =
  | PublicMediaFetchRefusalCode
  | 'INVALID_BASE64'
  | 'RATE_LIMITED'
  | 'ACCOUNT_DELETION_IN_PROGRESS'
  | 'UPLOAD_FAILED'
  /** No such upload of the caller's: an unknown id, another account's, or one that holds no file. */
  | 'NOT_FOUND'
  /** The upload was already used, or is being collected. */
  | 'CONFLICT';

export type AgentInputUploadResult =
  | {
      ok: true;
      /** What `create_media.inputs[]` takes for this file: the signed URL and the staged path. */
      input: { url: string; storagePath: string };
      kind: StorageMediaKind;
      bytes: number;
      mimeType: string;
      /** How long the signed URL lasts. */
      expiresInSeconds: number;
      /** The URL the bytes came from, where they came from one. */
      sourceUrl: string | null;
    }
  | {
      ok: false;
      code: AgentInputUploadRefusalCode;
      message: string;
      details?: Record<string, unknown>;
      retryAfterSeconds?: number;
    };

/** How many of a stored object's first bytes the signature rule reads: every listed signature sits in the first 12. */
export const AGENT_SIGNATURE_HEAD_BYTES = 64;
const SIGNATURE_READ_URL_SECONDS = 60;
const SIGNATURE_READ_TIMEOUT_MS = 10_000;

/**
 * The first bytes of a stored object, read through a one-minute signed URL with a `Range`
 * header, so a 50 MB clip costs the function 64 bytes. The body is read only until that many
 * have arrived and then cancelled, in case a server answers the whole object. Null when they
 * could not be read.
 */
export async function readStoredObjectHead(
  admin: SupabaseClient,
  { bucket, path }: { bucket: string; path: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer | null> {
  try {
    const signed = await admin.storage.from(bucket).createSignedUrl(path, SIGNATURE_READ_URL_SECONDS);
    const url = signed.data?.signedUrl;
    if (signed.error || !url) return null;
    const response = await fetchImpl(url, {
      headers: { range: `bytes=0-${AGENT_SIGNATURE_HEAD_BYTES - 1}` },
      signal: AbortSignal.timeout(SIGNATURE_READ_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < AGENT_SIGNATURE_HEAD_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
    return Buffer.concat(chunks).subarray(0, AGENT_SIGNATURE_HEAD_BYTES);
  } catch {
    return null;
  }
}

export type AgentInputUploadDependencies = {
  fetchPublicHttpsMedia: typeof fetchPublicHttpsMedia;
  createTemporaryMediaUploadIntent: typeof createTemporaryMediaUploadIntent;
  finalizeUploadById: typeof finalizeUploadById;
  createTemporaryMediaReadUrl: typeof createTemporaryMediaReadUrl;
  /** The first bytes of a stored object, for the signature rule; null when they could not be read. */
  readStoredObjectHead: (admin: SupabaseClient, location: { bucket: string; path: string }) => Promise<Buffer | null>;
  deleteReservedObjectAndConfirm: typeof deleteReservedObjectAndConfirm;
};

export function defaultAgentInputUploadDependencies(): AgentInputUploadDependencies {
  return {
    fetchPublicHttpsMedia,
    createTemporaryMediaUploadIntent,
    finalizeUploadById,
    createTemporaryMediaReadUrl,
    readStoredObjectHead,
    deleteReservedObjectAndConfirm,
  };
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
};

/** The name the staged object is filed under: the agent's own words never reach a path. */
export function agentUploadFileName(kind: StorageMediaKind, mimeType: string): string {
  const extension = EXTENSION_BY_MIME[mimeType] ?? mimeType.split('/')[1]?.split('+')[0] ?? 'bin';
  return `agent-${kind}.${extension}`;
}

type DecodedBytes =
  | { ok: true; bytes: Buffer; contentType: string; kind: StorageMediaKind }
  | Extract<AgentInputUploadResult, { ok: false }>;

/**
 * The bytes a base64 argument carries, held to the policy's types and the base64 cap. A data URL
 * is accepted too, its own type winning over none given.
 */
export function decodeAgentBase64(base64: string, mimeType: string): DecodedBytes {
  let payload = base64.trim();
  let declaredType = mimeType.trim();
  const dataUrl = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([\s\S]*)$/iu.exec(payload);
  if (dataUrl) {
    declaredType = declaredType || (dataUrl[1] ?? '');
    payload = dataUrl[2];
  }
  payload = payload.replace(/\s+/gu, '');
  if (!payload || !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload) || payload.length % 4 !== 0) {
    return { ok: false, code: 'INVALID_BASE64', message: 'base64 is not valid standard base64.' };
  }
  const contentType = canonicalStorageMediaMimeType(declaredType);
  const kind = mediaKindOfMimeType(contentType);
  if (!kind || !isAllowedStorageMediaMimeType(kind, contentType)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_MEDIA',
      message: `${contentType || 'No media type'} is not a picture, clip or track type Magicbooklet takes. Give mime_type as the file's own type.`,
      details: { mime_type: contentType || null },
    };
  }
  // The decoded size follows from the length, so a payload past the cap is refused unread.
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const decodedLength = (payload.length / 4) * 3 - padding;
  if (decodedLength > AGENT_BASE64_MAX_BYTES) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      message: `The file is ${decodedLength} bytes decoded; base64 takes at most ${AGENT_BASE64_MAX_BYTES}. Send a larger file by url.`,
      details: { bytes: decodedLength, max_bytes: AGENT_BASE64_MAX_BYTES },
    };
  }
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0) {
    return { ok: false, code: 'INVALID_BASE64', message: 'base64 decodes to nothing.' };
  }
  // A picture must carry a picture's signature (every listed picture type has one); a clip or a
  // track is refused only when its bytes say another kind (`public-url-media-fetch.ts`).
  const sniffed = sniffMediaKind(bytes);
  if (kind === 'image' ? sniffed !== 'image' : sniffed !== null && sniffed !== kind) {
    return {
      ok: false,
      code: 'UNSUPPORTED_MEDIA',
      message: sniffed
        ? `mime_type says ${contentType}, but the bytes are a ${sniffed}. Give the file's own type.`
        : `mime_type says ${contentType}, but the bytes are not a picture of a type Magicbooklet takes.`,
      details: { mime_type: contentType, sniffed_kind: sniffed },
    };
  }
  return { ok: true, bytes, contentType, kind };
}

async function obtainBytes(
  source: Exclude<AgentInputSource, { uploadId: string }>,
  dependencies: AgentInputUploadDependencies,
): Promise<DecodedBytes & { sourceUrl?: string | null }> {
  if ('url' in source) {
    const fetched = await dependencies.fetchPublicHttpsMedia(source.url, { maxBytesByKind: AGENT_URL_FETCH_MAX_BYTES_BY_KIND });
    if (!fetched.ok) return fetched;
    return { ok: true, bytes: fetched.bytes, contentType: fetched.contentType, kind: fetched.kind, sourceUrl: fetched.finalUrl };
  }
  return { ...decodeAgentBase64(source.base64, source.mimeType), sourceUrl: null };
}

type AgentInputRefusal = Extract<AgentInputUploadResult, { ok: false }>;

/** The sign step's refusals, as the agent's codes: its rate limit, a deleting account, a size or type it does not take. */
function signRefusal(intent: Extract<Awaited<ReturnType<typeof createTemporaryMediaUploadIntent>>, { ok: false }>): AgentInputRefusal {
  if (intent.code === 'RATE_LIMITED') {
    return { ok: false, code: 'RATE_LIMITED', message: intent.error, retryAfterSeconds: intent.retryAfterSeconds };
  }
  if (intent.code === 'ACCOUNT_DELETION_IN_PROGRESS') {
    return { ok: false, code: 'ACCOUNT_DELETION_IN_PROGRESS', message: intent.error };
  }
  if (intent.status === 400) {
    // The sign step's own reading of the size, the type or the file's name.
    return { ok: false, code: 'UNSUPPORTED_MEDIA', message: intent.error };
  }
  return { ok: false, code: 'UPLOAD_FAILED', message: intent.error };
}

/** The staged file as `create_media.inputs[]` and `publish_post.uploads[]` take it, with its signed read URL. */
async function answerStagedInput({
  admin,
  userId,
  descriptor,
  kind,
  sourceUrl,
  dependencies,
}: {
  admin: SupabaseClient;
  userId: string;
  descriptor: Extract<UploadFinalizationResult, { ok: true }>['descriptor'];
  kind: StorageMediaKind;
  sourceUrl: string | null;
  dependencies: AgentInputUploadDependencies;
}): Promise<AgentInputUploadResult> {
  const readUrl = await dependencies.createTemporaryMediaReadUrl({
    body: { storagePath: descriptor.storagePath },
    userId,
    client: admin as never,
  });
  if (!readUrl.ok) {
    if (readUrl.code === 'RATE_LIMITED') {
      return { ok: false, code: 'RATE_LIMITED', message: readUrl.error, retryAfterSeconds: readUrl.retryAfterSeconds };
    }
    return { ok: false, code: 'UPLOAD_FAILED', message: readUrl.error };
  }
  return {
    ok: true,
    input: { url: readUrl.response.signedUrl, storagePath: descriptor.storagePath },
    kind,
    bytes: descriptor.sizeBytes,
    mimeType: descriptor.contentType,
    expiresInSeconds: readUrl.response.expiresInSeconds,
    sourceUrl,
  };
}

/** What finalize answers for an `upload_id` it will not finalize, as the agent's codes with the next step. */
function uploadIdRefusal(uploadId: string, finalized: Extract<UploadFinalizationResult, { ok: false }>): AgentInputRefusal {
  const details = { upload_id: uploadId, finalize_code: finalized.code };
  if (finalized.code === 'UPLOAD_NOT_FOUND') {
    // 404: no such intent of the caller's, which is also what another account's id answers.
    return finalized.status === 404
      ? { ok: false, code: 'NOT_FOUND', message: `No upload ${uploadId} exists for this creator. request_upload gives an upload_id.`, details }
      : {
          ok: false,
          code: 'NOT_FOUND',
          message: `Upload ${uploadId} holds no file: nothing was stored at its upload_url before this call, or it was closed earlier. It cannot be used now. Call request_upload again, send the file with the command it gives, wait for that command to finish, then call upload_input.`,
          details,
        };
  }
  if (finalized.code === 'UPLOAD_METADATA_MISMATCH') {
    return {
      ok: false,
      code: 'UNSUPPORTED_MEDIA',
      message: `The file stored for upload ${uploadId} is not the one request_upload was told of: its size in bytes or its content-type differs, so it was removed. Call request_upload again with the file's exact size_bytes and mime_type, and send it with the headers given.`,
      details,
    };
  }
  if (finalized.code === 'UPLOAD_NOT_READY') {
    return {
      ok: false,
      code: 'CONFLICT',
      message: `Upload ${uploadId} is already used or being collected: ${finalized.error} A staged file is spent once a post is made from it; stage the file again to use it again.`,
      details,
    };
  }
  return { ok: false, code: 'UPLOAD_FAILED', message: finalized.error, details };
}

/**
 * The `upload_id` source: the agent PUT the file to the URL `requestAgentUpload` signed, and this
 * finalizes it for the caller (finalize loads the intent by id and owner, so another account's id
 * is no intent at all, and compares the stored size and type with the declared ones). The bytes
 * never passed through this server, so the signature rule the other sources apply to bytes they
 * hold is applied to the stored object's first bytes; a file that fails it is removed, and its
 * reservation closed, before the refusal is answered.
 */
async function stageUploadedFile({
  admin,
  userId,
  uploadId,
  dependencies,
}: {
  admin: SupabaseClient;
  userId: string;
  uploadId: string;
  dependencies: AgentInputUploadDependencies;
}): Promise<AgentInputUploadResult> {
  const finalized = await dependencies.finalizeUploadById(admin, { uploadId, userId });
  if (!finalized.ok) return uploadIdRefusal(uploadId, finalized);
  const { descriptor } = finalized;
  const kind = mediaKindOfMimeType(descriptor.contentType);
  if (descriptor.bucket !== STAGING_BUCKET || !kind) {
    // A reservation of the creator's in another bucket (a recipe file) is no staged input.
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: `No upload ${uploadId} exists for this creator. request_upload gives an upload_id.`,
      details: { upload_id: uploadId },
    };
  }

  const head = await dependencies.readStoredObjectHead(admin, { bucket: descriptor.bucket, path: descriptor.path });
  if (!head) {
    // Nothing is removed: the file may be fine, and the same call may pass in a moment.
    return { ok: false, code: 'UPLOAD_FAILED', message: 'The uploaded file could not be read to check it.', details: { upload_id: uploadId } };
  }
  const sniffed = sniffMediaKind(head);
  if (kind === 'image' ? sniffed !== 'image' : sniffed !== null && sniffed !== kind) {
    const removed = await dependencies.deleteReservedObjectAndConfirm(admin, descriptor.bucket, descriptor.path);
    if (removed) {
      // The reservation follows its object: finalize finds nothing stored and closes the intent,
      // as it closes one nothing was ever sent to.
      await dependencies.finalizeUploadById(admin, { uploadId, userId });
    } else {
      // Left for the reclaim sweep, which collects an upload nothing used.
      logBackendError('agent_upload_signature_mismatch_not_removed', { uploadId });
    }
    return {
      ok: false,
      code: 'UNSUPPORTED_MEDIA',
      message: sniffed
        ? `request_upload was told ${descriptor.contentType}, but the file's bytes are ${KIND_NOUN[sniffed]}. It was removed; call request_upload again with the file's own type.`
        : `request_upload was told ${descriptor.contentType}, but the file's bytes are not a picture of a type Magicbooklet takes. It was removed.`,
      details: { upload_id: uploadId, mime_type: descriptor.contentType, sniffed_kind: sniffed },
    };
  }

  return answerStagedInput({ admin, userId, descriptor, kind, sourceUrl: null, dependencies });
}

/**
 * Stages one file for the creator and answers what `create_media` and `publish_post` take for
 * it. The admin client is the service role's: the sign step reserves and records under it, the
 * bytes go up under it, and finalize reads the stored object under it, as the upload routes do
 * behind the proxy.
 */
export async function stageAgentInput({
  admin,
  userId,
  source,
  dependencies = defaultAgentInputUploadDependencies(),
}: {
  admin: SupabaseClient;
  userId: string;
  source: AgentInputSource;
  dependencies?: AgentInputUploadDependencies;
}): Promise<AgentInputUploadResult> {
  if ('uploadId' in source) {
    return stageUploadedFile({ admin, userId, uploadId: source.uploadId, dependencies });
  }
  const obtained = await obtainBytes(source, dependencies);
  if (!obtained.ok) return obtained;
  const { bytes, contentType, kind } = obtained;

  const intent = await dependencies.createTemporaryMediaUploadIntent({
    body: { fileName: agentUploadFileName(kind, contentType), mimeType: contentType, kind, sizeBytes: bytes.length },
    userId,
    client: admin as never,
  });
  if (!intent.ok) return signRefusal(intent);

  // A Blob, never a Buffer: a Buffer is UTF-8 stringified in transit (`storage-upload-body.ts`).
  // Built here rather than with `toStorageUploadBody`, which copies the bytes first: these are a
  // fresh `Buffer.concat` or a decode, nothing pooled, and the Blob takes its own snapshot, so one
  // copy is enough for a file that may be 50 MB.
  const view: BlobPart = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  const uploaded = await admin.storage
    .from(intent.response.bucket)
    .upload(intent.response.path, new Blob([view], { type: intent.response.contentType }), {
      contentType: intent.response.contentType,
      upsert: false,
    });
  if (uploaded.error) {
    // The reservation stays issued; the sweep drops it once the signed URL lapses, as it drops any
    // upload a client abandoned.
    return { ok: false, code: 'UPLOAD_FAILED', message: 'The file could not be stored. Try again.' };
  }

  const finalized = await dependencies.finalizeUploadById(admin, { uploadId: intent.response.uploadId, userId });
  if (!finalized.ok) {
    return {
      ok: false,
      code: finalized.code === 'UPLOAD_METADATA_MISMATCH' ? 'UNSUPPORTED_MEDIA' : 'UPLOAD_FAILED',
      message: finalized.error,
      details: { finalize_code: finalized.code },
    };
  }

  return answerStagedInput({
    admin,
    userId,
    descriptor: finalized.descriptor,
    kind,
    sourceUrl: obtained.sourceUrl ?? null,
    dependencies,
  });
}

// ---------------------------------------------------------------------------------------------
// A local file: the agent sends it to Storage itself

export type AgentUploadRequest = {
  /** The file's name on the agent's machine; the sign step files the upload under a cleaned form of it. */
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export type AgentUploadRequestResult =
  | {
      ok: true;
      uploadId: string;
      /** The signed URL the file is PUT to, good for `expiresInSeconds`. */
      uploadUrl: string;
      /**
       * The headers the PUT carries, the ones the web's own upload sends (`signed-url-upload.ts`):
       * the type finalize checks the stored object against, no overwrite, and the cache lifetime a
       * published copy keeps (a copy into the public bucket carries its source's).
       */
      headers: { 'content-type': string; 'x-upsert': 'false'; 'cache-control': string };
      storagePath: string;
      kind: StorageMediaKind;
      mimeType: string;
      sizeBytes: number;
      expiresInSeconds: number;
      /** The most bytes a file of this kind may be, sent this way. */
      maxBytes: number;
    }
  | AgentInputRefusal;

export type AgentUploadRequestDependencies = Pick<AgentInputUploadDependencies, 'createTemporaryMediaUploadIntent'>;

/**
 * Signs an upload for a file on the agent's own machine (Claude Code, Codex and Cursor have a
 * shell; a chat client has none and sends a link instead). The agent declares the file's type and
 * exact size, which the sign step reserves and finalize later holds the stored object to, and
 * gets back a URL to PUT the bytes to. Held to the caps a URL fetch has, though nothing is
 * buffered here: one set of numbers for an agent to learn, and a clip above them belongs in the
 * web's composer, which uploads in resumable chunks.
 */
export async function requestAgentUpload({
  admin,
  userId,
  request,
  dependencies = defaultAgentInputUploadDependencies(),
}: {
  admin: SupabaseClient;
  userId: string;
  request: AgentUploadRequest;
  dependencies?: AgentUploadRequestDependencies;
}): Promise<AgentUploadRequestResult> {
  const contentType = canonicalContentType(request.mimeType);
  const kind = mediaKindOfMimeType(contentType);
  if (!kind || !isAllowedStorageMediaMimeType(kind, contentType)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_MEDIA',
      message: `${contentType || 'No media type'} is not a picture, clip or track type Magicbooklet takes. Give mime_type as the file's own type.`,
      details: { mime_type: contentType || null },
    };
  }
  const maxBytes = AGENT_URL_FETCH_MAX_BYTES_BY_KIND[kind];
  if (request.sizeBytes > maxBytes) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      message: `The file is ${request.sizeBytes} bytes; ${KIND_NOUN[kind]} sent this way may be at most ${maxBytes}.`,
      details: { bytes: request.sizeBytes, max_bytes: maxBytes },
    };
  }

  const intent = await dependencies.createTemporaryMediaUploadIntent({
    body: { fileName: request.fileName, mimeType: contentType, kind, sizeBytes: request.sizeBytes },
    userId,
    client: admin as never,
  });
  if (!intent.ok) return signRefusal(intent);

  const { response } = intent;
  let uploadUrl: string;
  try {
    uploadUrl = resolveSignedUploadUrl({
      bucket: response.bucket,
      path: response.path,
      token: response.token,
      signedUploadUrl: response.signedUploadUrl,
    });
  } catch {
    return { ok: false, code: 'UPLOAD_FAILED', message: 'The upload could not be prepared.' };
  }
  return {
    ok: true,
    uploadId: response.uploadId,
    uploadUrl,
    headers: {
      'content-type': response.contentType,
      'x-upsert': 'false',
      'cache-control': `max-age=${SHOWCASE_PUBLIC_MEDIA_CACHE_TTL_SECONDS}`,
    },
    storagePath: response.storagePath,
    kind,
    mimeType: response.contentType,
    sizeBytes: request.sizeBytes,
    expiresInSeconds: response.expiresInSeconds,
    maxBytes,
  };
}

/** A word for a POSIX shell, single-quoted: nothing inside is expanded, and a quote inside closes, escapes and reopens. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/**
 * The one-line command that sends a local file to a signed upload URL: a raw PUT of the bytes
 * with the headers the answer names. `FILE` stands for the file's path, which the agent fills in
 * itself: the file's name is never echoed into the command, so nothing an agent was told to send
 * reaches a shell through this server's words. The URL and the header values are this server's
 * own (a signed path is the sign step's cleaned name, the token a JWT) and are quoted all the
 * same.
 */
export function agentUploadCurlCommand(upload: Pick<Extract<AgentUploadRequestResult, { ok: true }>, 'uploadUrl' | 'headers'>): string {
  const headers = Object.entries(upload.headers).map(([name, value]) => `-H ${shellQuote(`${name}: ${value}`)}`).join(' ');
  return `curl -sS -X PUT ${headers} --data-binary @FILE ${shellQuote(upload.uploadUrl)}`;
}

// ---------------------------------------------------------------------------------------------
// Staged files, as a publish reads them

export type AgentStagedUpload =
  | {
      /** An upload signed for the caller. */
      kind: 'staged';
      /** Where it stands: only `finalized` (through `upload_input`, not yet used) is a file a post can be made from. */
      status: UploadReservationRow['finalization_status'];
      /** The type the stored object carries, as the lists name it, else the type that was declared. */
      contentType: string | null;
    }
  /** A path in the caller's own staging folder that no upload was signed for. */
  | { kind: 'unknown' }
  /** A path outside the caller's staging folder: another account's, another bucket's, or no path at all. */
  | { kind: 'foreign' };

/**
 * What stands behind each path a publish names, keyed by the path as given. The tool judges the
 * caller's own paths by it (staged through `upload_input` and unused, or not); a path that is not
 * the caller's is left to the composer service, whose ownership rule refuses it.
 */
export async function readAgentStagedUploads(
  admin: SupabaseClient,
  { userId, storagePaths }: { userId: string; storagePaths: readonly string[] },
): Promise<{ ok: true; uploads: Map<string, AgentStagedUpload> } | { ok: false }> {
  const uploads = new Map<string, AgentStagedUpload>();
  const filePathByGiven = new Map<string, string>();
  for (const storagePath of storagePaths) {
    const location = parseCanonicalStorageLocation(storagePath, { allowedBuckets: [STAGING_BUCKET], ownerUserId: userId });
    if (location) {
      filePathByGiven.set(storagePath, location.filePath);
    } else {
      uploads.set(storagePath, { kind: 'foreign' });
    }
  }
  if (filePathByGiven.size === 0) return { ok: true, uploads };
  const { data, error } = await admin
    .from(UPLOAD_RESERVATIONS_TABLE)
    .select('storage_path, finalization_status, actual_content_type, expected_content_type')
    .eq('user_id', userId)
    .eq('bucket_id', STAGING_BUCKET)
    .in('storage_path', [...new Set(filePathByGiven.values())]);
  if (error) return { ok: false };
  const rows = new Map(
    ((data ?? []) as Array<Pick<UploadReservationRow, 'storage_path' | 'finalization_status' | 'actual_content_type' | 'expected_content_type'>>)
      .map((row) => [row.storage_path, row]),
  );
  for (const [given, filePath] of filePathByGiven) {
    const row = rows.get(filePath);
    if (!row) {
      uploads.set(given, { kind: 'unknown' });
      continue;
    }
    const type = row.actual_content_type ?? row.expected_content_type;
    uploads.set(given, {
      kind: 'staged',
      status: row.finalization_status,
      contentType: type ? canonicalStorageMediaMimeType(type) : null,
    });
  }
  return { ok: true, uploads };
}
