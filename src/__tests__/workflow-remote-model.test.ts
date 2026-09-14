import { beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import fixture from '../../contracts/model-catalog-transport-v1.json';
import {
  createCanvasEdge,
  createWorkflowNode,
  normalizeWorkflowGraph,
} from '@/lib/workflow-canvas';
const mocks = vi.hoisted(() => ({
  quote: vi.fn(),
  pinnedQuote: vi.fn(),
  start: vi.fn(),
  startImage: vi.fn(),
  operation: vi.fn(),
}));
vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({}),
  resolveOwnedStoredMediaUrl: vi.fn(),
}));
vi.mock('@/lib/generation-model-catalog-store', () => ({
  quotePublishedGenerationModel: mocks.quote,
  quotePublishedGenerationModelAtRevision: mocks.pinnedQuote,
  loadGenerationModelOperationByRevision: mocks.operation,
}));
vi.mock('@/lib/generation-services', () => ({
  startCatalogGeneration: mocks.start,
  startImageGeneration: mocks.startImage,
  startMotionGeneration: vi.fn(),
  startVideoGeneration: vi.fn(),
  startSoundEffectGeneration: vi.fn(),
  startVoiceoverGeneration: vi.fn(),
}));
import { executeWorkflowRunnableNode } from '@/lib/workflow-runner';
function graph() {
  const prompt = createWorkflowNode('text-input', { x: 0, y: 0 });
  prompt.data.text = 'Preserve my prompt';
  const image = createWorkflowNode('image-generate', { x: 300, y: 0 });
  image.data.model = 'future-image-model';
  image.data.catalogSettings = {
    background: 'transparent',
    aspectRatio: '1:1',
  };
  return normalizeWorkflowGraph({
    nodes: [prompt, image],
    edges: [createCanvasEdge(prompt.id, 'text', image.id, 'prompt')],
    version: 2,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.operation.mockResolvedValue({
    catalog: { models: fixture.details.models },
    operation: {
      modelId: 'future-image-model',
      kind: 'image',
      adapterKey: 'kie-task-v1',
    },
  });
  mocks.quote.mockResolvedValue({
    costCredits: 7,
    catalogRevision: 'active',
    normalizedSettings: { background: 'transparent', aspectRatio: '1:1' },
  });
  mocks.pinnedQuote.mockResolvedValue({
    costCredits: 9,
    catalogRevision: 'trusted-pin',
    normalizedSettings: { background: 'transparent' },
  });
  mocks.start.mockResolvedValue({
    generationId: 'g1',
    predictionId: 'p1',
    cost: 7,
  });
  mocks.startImage.mockResolvedValue({
    generationId: 'g2',
    predictionId: 'p2',
    cost: 5,
  });
});
it('keeps a bundled model on its model-specific branch when the editor only recorded an empty settings object', async () => {
  const value = graph();
  value.nodes[1].data.model = 'nano-banana-2';
  value.nodes[1].data.catalogSettings = {};
  const result = await executeWorkflowRunnableNode({
    supabase: {} as SupabaseClient,
    userId: 'u1',
    node: value.nodes[1],
    graph: value,
    catalogRevision: 'active',
  });
  expect(result.status).toBe('processing');
  expect(mocks.operation).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.startImage).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'nano-banana-2', prompt: 'Preserve my prompt' }),
  );
});
it('runs a bundled model through the catalog only when catalog-only settings were recorded', async () => {
  const value = graph();
  value.nodes[1].data.model = 'nano-banana-2';
  value.nodes[1].data.catalogSettings = { background: 'transparent' };
  mocks.operation.mockResolvedValue({
    catalog: { models: [{ ...fixture.details.models[0], id: 'nano-banana-2' }] },
    operation: { modelId: 'nano-banana-2', kind: 'image', adapterKey: 'kie-task-v1' },
  });
  await executeWorkflowRunnableNode({
    supabase: {} as SupabaseClient,
    userId: 'u1',
    node: value.nodes[1],
    graph: value,
    catalogRevision: 'active',
  });
  expect(mocks.startImage).not.toHaveBeenCalled();
  expect(mocks.start).toHaveBeenCalledWith(
    expect.objectContaining({ settings: expect.objectContaining({ background: 'transparent' }) }),
  );
});
it('reports missing inputs and a missing revision as blocked steps, not failures', async () => {
  const image = createWorkflowNode('image-generate', { x: 0, y: 0 });
  image.data.model = 'future-image-model';
  const value = normalizeWorkflowGraph({ nodes: [image], edges: [], version: 2 });
  const unprompted = await executeWorkflowRunnableNode({
    supabase: {} as SupabaseClient,
    userId: 'u1',
    node: value.nodes[0],
    graph: value,
    catalogRevision: 'active',
  });
  expect(unprompted).toMatchObject({
    status: 'blocked',
    error_message: 'Image generator is missing a prompt input.',
  });
  const unpinned = await executeWorkflowRunnableNode({
    supabase: {} as SupabaseClient,
    userId: 'u1',
    node: graph().nodes[1],
    graph: graph(),
    catalogRevision: null,
  });
  expect(unpinned).toMatchObject({
    status: 'blocked',
    error_message: 'Refresh model settings before running this workflow.',
  });
  expect(mocks.start).not.toHaveBeenCalled();
});
it('round-trips a remote model and dispatches its descriptor settings', async () => {
  const value = graph();
  expect(value.nodes[1].data).toMatchObject({
    model: 'future-image-model',
    catalogSettings: { background: 'transparent' },
  });
  const result = await executeWorkflowRunnableNode({
    supabase: {} as SupabaseClient,
    userId: 'u1',
    node: value.nodes[1],
    graph: value,
    catalogRevision: 'active',
  });
  expect(result.status).toBe('processing');
  expect(mocks.start).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: 'Preserve my prompt',
      settings: expect.objectContaining({ background: 'transparent' }),
      catalogRevision: 'active',
    }),
  );
});
it('rejects stale ordinary workflow quotes before starting a provider request', async () => {
  const value = graph();
  mocks.quote.mockRejectedValue(new Error('CATALOG_CHANGED'));
  await expect(
    executeWorkflowRunnableNode({
      supabase: {} as SupabaseClient,
      userId: 'u1',
      node: value.nodes[1],
      graph: value,
      catalogRevision: 'old',
    }),
  ).rejects.toThrow('CATALOG_CHANGED');
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.pinnedQuote).not.toHaveBeenCalled();
});
it('preserves trusted template pinning and private recipe options', async () => {
  const value = graph();
  await executeWorkflowRunnableNode({
    supabase: {} as SupabaseClient,
    userId: 'u1',
    node: value.nodes[1],
    graph: value,
    catalogRevision: 'trusted-pin',
    quoteAtPinnedRevision: true,
    privateRecipe: true,
    persistInputMedia: false,
  });
  expect(mocks.quote).not.toHaveBeenCalled();
  expect(mocks.start).toHaveBeenCalledWith(
    expect.objectContaining({
      catalogRevision: 'trusted-pin',
      privateRecipe: true,
      persistInputMedia: false,
    }),
  );
});
