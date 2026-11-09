import type { SupabaseClient } from '@supabase/supabase-js';

import {
  fetchPublicHttpsMedia,
  mediaKindOfMimeType,
  sniffMediaKind,
  type PublicMediaFetchRefusalCode,
} from '@/lib/public-url-media-fetch';
import { toStorageUploadBody } from '@/lib/storage-upload-body';
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
import { finalizeUploadById } from '@/lib/upload-finalization';

/**
 * Stages a file an agent sends for a run, the way the web's creators stage one: the sign step
 * reserves the bytes and records the intent, the bytes go up as a Blob under the type the sign
 * step kept, finalize checks the stored object against what was declared, and a signed read URL
 * is minted for the hour. Because it is the same staging path, the reclaim sweep collects an
 * upload no run ever used and the byte reservations count it like any other
 * (`upload-finalization.ts`, `upload-byte-admission.ts`).
 *
 * The bytes come from a public https URL (`public-url-media-fetch.ts` decides what public means
 * and holds the download to the caps) or from a base64 string, which is bounded far lower: a tool
 * argument travels through the agent's context and the MCP request body, so 8 MB decoded is the
 * most that is sensible there, and a larger file is sent by URL.
 */

export const AGENT_BASE64_MAX_BYTES = 8 * 1024 * 1024;
/** The sign step's own caps (`TEMPORARY_MEDIA_UPLOAD_LIMITS` mirrors them for the browser). */
export const AGENT_UPLOAD_MAX_BYTES_BY_KIND: Record<StorageMediaKind, number> = MAX_UPLOAD_BYTES_BY_KIND;

export type AgentInputSource =
  | { url: string }
  | { base64: string; mimeType: string };

export type AgentInputUploadRefusalCode =
  | PublicMediaFetchRefusalCode
  | 'INVALID_BASE64'
  | 'RATE_LIMITED'
  | 'ACCOUNT_DELETION_IN_PROGRESS'
  | 'UPLOAD_FAILED';

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

export type AgentInputUploadDependencies = {
  fetchPublicHttpsMedia: typeof fetchPublicHttpsMedia;
  createTemporaryMediaUploadIntent: typeof createTemporaryMediaUploadIntent;
  finalizeUploadById: typeof finalizeUploadById;
  createTemporaryMediaReadUrl: typeof createTemporaryMediaReadUrl;
};

export function defaultAgentInputUploadDependencies(): AgentInputUploadDependencies {
  return { fetchPublicHttpsMedia, createTemporaryMediaUploadIntent, finalizeUploadById, createTemporaryMediaReadUrl };
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
  const sniffed = sniffMediaKind(bytes);
  if (sniffed && sniffed !== kind) {
    return {
      ok: false,
      code: 'UNSUPPORTED_MEDIA',
      message: `mime_type says ${contentType}, but the bytes are a ${sniffed}. Give the file's own type.`,
      details: { mime_type: contentType, sniffed_kind: sniffed },
    };
  }
  return { ok: true, bytes, contentType, kind };
}

async function obtainBytes(
  source: AgentInputSource,
  dependencies: AgentInputUploadDependencies,
): Promise<DecodedBytes & { sourceUrl?: string | null }> {
  if ('url' in source) {
    const fetched = await dependencies.fetchPublicHttpsMedia(source.url, { maxBytesByKind: AGENT_UPLOAD_MAX_BYTES_BY_KIND });
    if (!fetched.ok) return fetched;
    return { ok: true, bytes: fetched.bytes, contentType: fetched.contentType, kind: fetched.kind, sourceUrl: fetched.finalUrl };
  }
  return { ...decodeAgentBase64(source.base64, source.mimeType), sourceUrl: null };
}

/**
 * Stages one file for the creator and answers what `create_media` takes for it. The admin client
 * is the service role's: the sign step reserves and records under it, the bytes go up under it,
 * and finalize reads the stored object under it, as the upload routes do behind the proxy.
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
  const obtained = await obtainBytes(source, dependencies);
  if (!obtained.ok) return obtained;
  const { bytes, contentType, kind } = obtained;

  const intent = await dependencies.createTemporaryMediaUploadIntent({
    body: { fileName: agentUploadFileName(kind, contentType), mimeType: contentType, kind, sizeBytes: bytes.length },
    userId,
    client: admin as never,
  });
  if (!intent.ok) {
    if (intent.code === 'RATE_LIMITED') {
      return { ok: false, code: 'RATE_LIMITED', message: intent.error, retryAfterSeconds: intent.retryAfterSeconds };
    }
    if (intent.code === 'ACCOUNT_DELETION_IN_PROGRESS') {
      return { ok: false, code: 'ACCOUNT_DELETION_IN_PROGRESS', message: intent.error };
    }
    if (intent.status === 400) {
      // The sign step's own reading of the size or type: the caps above should have caught it.
      return { ok: false, code: 'UNSUPPORTED_MEDIA', message: intent.error };
    }
    return { ok: false, code: 'UPLOAD_FAILED', message: intent.error };
  }

  // A Blob, never a Buffer: a Buffer is UTF-8 stringified in transit (`storage-upload-body.ts`).
  const uploaded = await admin.storage
    .from(intent.response.bucket)
    .upload(intent.response.path, toStorageUploadBody(bytes, intent.response.contentType), {
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

  const readUrl = await dependencies.createTemporaryMediaReadUrl({
    body: { storagePath: finalized.descriptor.storagePath },
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
    input: { url: readUrl.response.signedUrl, storagePath: finalized.descriptor.storagePath },
    kind,
    bytes: finalized.descriptor.sizeBytes,
    mimeType: finalized.descriptor.contentType,
    expiresInSeconds: readUrl.response.expiresInSeconds,
    sourceUrl: obtained.sourceUrl ?? null,
  };
}
