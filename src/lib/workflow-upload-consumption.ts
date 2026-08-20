import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { WorkflowCanvasGraph } from '@/lib/workflow-canvas';
import {
  abortNullableUploadByteConsumption,
  completeUploadByteConsumptions,
  type UploadConsumptionClaim,
  type UploadReservationMutationResult,
} from '@/lib/upload-byte-admission';
import { finalizeUploadForConsumption } from '@/lib/upload-finalization';
import { getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';

const WORKFLOW_UPLOAD_BUCKETS = [
  'generated_images',
  'generated_videos',
  'generated_audio',
] as const;

export type WorkflowUploadLocation = {
  bucket: typeof WORKFLOW_UPLOAD_BUCKETS[number];
  storagePath: string;
};

export type PreparedWorkflowUploadLocation = WorkflowUploadLocation & {
  consumptionClaim: UploadConsumptionClaim | null;
};

export type PrepareWorkflowUploadsResult =
  | { ok: true; locations: PreparedWorkflowUploadLocation[] }
  | { ok: false; status: 400 | 409 | 500; error: string; code?: string };

function collectStoragePathValues(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStoragePathValues(entry, output));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'storagePath' && typeof entry === 'string' && entry.trim()) {
      output.push(entry);
    } else {
      collectStoragePathValues(entry, output);
    }
  }
}

export function getWorkflowUploadLocations(
  graph: WorkflowCanvasGraph,
  userId: string,
): WorkflowUploadLocation[] | null {
  const candidates: string[] = [];
  collectStoragePathValues(graph, candidates);
  const unique = new Map<string, WorkflowUploadLocation>();

  for (const candidate of candidates) {
    const location = getUserOwnedStoredMediaLocation(candidate, userId, {
      allowedBuckets: WORKFLOW_UPLOAD_BUCKETS,
    });
    if (!location) return null;
    const key = `${location.bucket}/${location.filePath}`;
    unique.set(key, {
      bucket: location.bucket as WorkflowUploadLocation['bucket'],
      storagePath: location.filePath,
    });
  }

  return [...unique.values()];
}

/** Verify every newly persisted workflow upload using trusted Storage metadata. */
export async function prepareWorkflowUploadsForPersistence(
  client: SupabaseClient,
  graph: WorkflowCanvasGraph,
  userId: string,
): Promise<PrepareWorkflowUploadsResult> {
  const locations = getWorkflowUploadLocations(graph, userId);
  if (!locations) {
    return {
      ok: false,
      status: 400,
      error: 'Workflow media contained an invalid storage path.',
      code: 'INVALID_WORKFLOW_MEDIA_PATH',
    };
  }

  const prepared: PreparedWorkflowUploadLocation[] = [];
  for (const location of locations) {
    let result: Awaited<ReturnType<typeof finalizeUploadForConsumption>>;
    try {
      result = await finalizeUploadForConsumption(client, {
        bucket: location.bucket,
        storagePath: location.storagePath,
        userId,
        disposition: 'preserve',
      });
    } catch {
      await Promise.all(prepared.map((entry) => (
        abortNullableUploadByteConsumption(client, entry.consumptionClaim)
      )));
      return {
        ok: false,
        status: 500,
        error: 'Failed to verify workflow media.',
        code: 'UPLOAD_FINALIZATION_UNAVAILABLE',
      };
    }
    if (!result.ok) {
      await Promise.all(prepared.map((entry) => (
        abortNullableUploadByteConsumption(client, entry.consumptionClaim)
      )));
      return {
        ok: false,
        status: result.status === 400 || result.status === 404 ? 400 : result.status,
        error: result.error,
        code: result.code,
      };
    }
    prepared.push({ ...location, consumptionClaim: result.consumptionClaim });
  }

  return { ok: true, locations: prepared };
}

/** Release admission capacity only after the graph has a durable owner row. */
export async function consumePersistedWorkflowUploads(
  client: SupabaseClient,
  locations: readonly PreparedWorkflowUploadLocation[],
  _userId: string,
): Promise<UploadReservationMutationResult> {
  void _userId;
  return completeUploadByteConsumptions(
    client,
    locations.map((location) => location.consumptionClaim),
  );
}

export async function abortPreparedWorkflowUploads(
  client: SupabaseClient,
  locations: readonly PreparedWorkflowUploadLocation[],
): Promise<void> {
  await Promise.all(locations.map((location) => (
    abortNullableUploadByteConsumption(client, location.consumptionClaim)
  )));
}
