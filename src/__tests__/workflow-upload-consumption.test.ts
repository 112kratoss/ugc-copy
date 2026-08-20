import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createStarterGraph, type WorkflowCanvasGraph } from '@/lib/workflow-canvas';
import {
  consumePersistedWorkflowUploads,
  getWorkflowUploadLocations,
  prepareWorkflowUploadsForPersistence,
} from '@/lib/workflow-upload-consumption';

const { finalizeUploadForConsumptionMock } = vi.hoisted(() => ({
  finalizeUploadForConsumptionMock: vi.fn(),
}));

vi.mock('@/lib/upload-finalization', () => ({
  finalizeUploadForConsumption: finalizeUploadForConsumptionMock,
}));

const USER_ID = '10000000-0000-4000-8000-000000000001';
const UPLOAD_ID = '20000000-0000-4000-8000-000000000002';
const SECOND_UPLOAD_ID = '30000000-0000-4000-8000-000000000003';
const FILE_PATH = `${USER_ID}/workflow-input-${UPLOAD_ID}-reference.png`;
const SECOND_FILE_PATH = `${USER_ID}/workflow-input-${SECOND_UPLOAD_ID}-reference.png`;
const STORAGE_PATH = `generated_images/${FILE_PATH}`;
const SECOND_STORAGE_PATH = `generated_images/${SECOND_FILE_PATH}`;

function graphWithStoragePath(storagePath: string): WorkflowCanvasGraph {
  const graph = createStarterGraph();
  return {
    ...graph,
    nodes: graph.nodes.map((node) => node.type === 'image-input'
      ? {
          ...node,
          data: {
            ...node.data,
            imageUrl: 'https://storage.example.test/short-lived-preview',
            storagePath,
          },
        }
      : node),
  };
}

function graphWithTwoStoragePaths(): WorkflowCanvasGraph {
  const graph = graphWithStoragePath(STORAGE_PATH);
  const imageInput = graph.nodes.find((node) => node.type === 'image-input');
  if (!imageInput) throw new Error('Starter workflow is missing its image input.');
  return {
    ...graph,
    nodes: [
      ...graph.nodes,
      {
        ...imageInput,
        id: 'second-image-input',
        data: {
          ...imageInput.data,
          storagePath: SECOND_STORAGE_PATH,
        },
      },
    ],
  };
}

function createRpcClient(
  implementation: (fn: string, args: Record<string, unknown>) => Promise<{
    data: unknown;
    error: unknown;
  }> = async () => ({ data: true, error: null }),
) {
  const rpc = vi.fn(implementation);
  return {
    client: { rpc } as unknown as SupabaseClient,
    rpc,
  };
}

function finalizedResult({
  uploadId = UPLOAD_ID,
  filePath = FILE_PATH,
  leaseId = '40000000-0000-4000-8000-000000000004',
}: {
  uploadId?: string;
  filePath?: string;
  leaseId?: string;
} = {}) {
  return {
    ok: true as const,
    descriptor: {
      bucket: 'generated_images',
      path: filePath,
      storagePath: `generated_images/${filePath}`,
      contentType: 'image/png',
      sizeBytes: 11,
    },
    canonicalPath: filePath,
    reservationId: uploadId,
    consumptionClaim: {
      uploadId,
      userId: USER_ID,
      leaseId,
      disposition: 'preserve' as const,
    },
  };
}

describe('workflow upload persistence boundary', () => {
  beforeEach(() => {
    finalizeUploadForConsumptionMock.mockReset();
  });

  it('extracts only canonical, owned workflow upload locations and deduplicates them', () => {
    const graph = graphWithStoragePath(STORAGE_PATH);
    graph.nodes.push({
      ...graph.nodes.find((node) => node.type === 'image-input')!,
      id: 'duplicate-image-input',
    });

    expect(getWorkflowUploadLocations(graph, USER_ID)).toEqual([{
      bucket: 'generated_images',
      storagePath: FILE_PATH,
    }]);

    for (const storagePath of [
      `generated_images/${USER_ID}/%252e%252e/reference.png`,
      `generated_images/${USER_ID}%252fother-user/reference.png`,
      `generated_images/${USER_ID}\\other-user/reference.png`,
      `generated_images/${USER_ID}//reference.png`,
      `generated_images/30000000-0000-4000-8000-000000000003/reference.png`,
    ]) {
      expect(getWorkflowUploadLocations(graphWithStoragePath(storagePath), USER_ID)).toBeNull();
    }
  });

  it('claims before persistence and completes that exact lease afterward', async () => {
    const upload = createRpcClient();
    const finalized = finalizedResult();
    finalizeUploadForConsumptionMock.mockResolvedValueOnce(finalized);

    const prepared = await prepareWorkflowUploadsForPersistence(
      upload.client,
      graphWithStoragePath(STORAGE_PATH),
      USER_ID,
    );

    expect(prepared).toEqual({
      ok: true,
      locations: [{
        bucket: 'generated_images',
        storagePath: FILE_PATH,
        consumptionClaim: finalized.consumptionClaim,
      }],
    });
    expect(finalizeUploadForConsumptionMock).toHaveBeenCalledWith(upload.client, {
      bucket: 'generated_images',
      storagePath: FILE_PATH,
      userId: USER_ID,
      disposition: 'preserve',
    });

    if (!prepared.ok) throw new Error('Expected a prepared workflow upload.');
    await expect(consumePersistedWorkflowUploads(
      upload.client,
      prepared.locations,
      USER_ID,
    )).resolves.toEqual({ ok: true });
    expect(upload.rpc).toHaveBeenCalledWith('complete_upload_byte_reservation_consumption', {
      p_upload_id: UPLOAD_ID,
      p_user_id: USER_ID,
      p_lease_id: finalized.consumptionClaim.leaseId,
      p_disposition: 'preserve',
    });
  });

  it('keeps the no-reservation compatibility path lease-free', async () => {
    const upload = createRpcClient();
    finalizeUploadForConsumptionMock.mockResolvedValueOnce({
      ok: true,
      descriptor: null,
      canonicalPath: FILE_PATH,
      reservationId: null,
      consumptionClaim: null,
    });

    const prepared = await prepareWorkflowUploadsForPersistence(
      upload.client,
      graphWithStoragePath(STORAGE_PATH),
      USER_ID,
    );
    expect(prepared).toEqual({
      ok: true,
      locations: [{
        bucket: 'generated_images',
        storagePath: FILE_PATH,
        consumptionClaim: null,
      }],
    });

    if (!prepared.ok) throw new Error('Expected a compatibility upload.');
    await expect(consumePersistedWorkflowUploads(
      upload.client,
      prepared.locations,
      USER_ID,
    )).resolves.toEqual({ ok: true });
    expect(upload.rpc).not.toHaveBeenCalled();
  });

  it('aborts every earlier claim when a later upload cannot be prepared', async () => {
    const upload = createRpcClient();
    const first = finalizedResult();
    finalizeUploadForConsumptionMock
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        code: 'UPLOAD_NOT_READY',
        error: 'That upload is already being consumed.',
      });

    await expect(prepareWorkflowUploadsForPersistence(
      upload.client,
      graphWithTwoStoragePaths(),
      USER_ID,
    )).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: 'UPLOAD_NOT_READY',
    });
    expect(upload.rpc).toHaveBeenCalledTimes(1);
    expect(upload.rpc).toHaveBeenCalledWith('abort_upload_byte_reservation_consumption', {
      p_upload_id: first.consumptionClaim.uploadId,
      p_user_id: USER_ID,
      p_lease_id: first.consumptionClaim.leaseId,
    });
  });

  it('attempts every post-commit completion even when one lease conflicts', async () => {
    const first = finalizedResult();
    const second = finalizedResult({
      uploadId: SECOND_UPLOAD_ID,
      filePath: SECOND_FILE_PATH,
      leaseId: '50000000-0000-4000-8000-000000000005',
    });
    const upload = createRpcClient(async (fn, args) => ({
      data: fn === 'complete_upload_byte_reservation_consumption'
        && args.p_upload_id === first.consumptionClaim.uploadId
        ? false
        : true,
      error: null,
    }));

    await expect(consumePersistedWorkflowUploads(upload.client, [
      {
        bucket: 'generated_images',
        storagePath: FILE_PATH,
        consumptionClaim: first.consumptionClaim,
      },
      {
        bucket: 'generated_images',
        storagePath: SECOND_FILE_PATH,
        consumptionClaim: second.consumptionClaim,
      },
    ], USER_ID)).resolves.toMatchObject({ ok: false, kind: 'conflict' });

    expect(upload.rpc).toHaveBeenCalledTimes(2);
    expect(upload.rpc.mock.calls.map(([, args]) => args.p_upload_id)).toEqual([
      UPLOAD_ID,
      SECOND_UPLOAD_ID,
    ]);
  });
});
