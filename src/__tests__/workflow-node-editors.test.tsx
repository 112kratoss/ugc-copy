import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkflowCanvasInspector } from '@/app/create-workflow/WorkflowNodeEditors';
import {
  createStarterGraph,
  createWorkflowNode,
  normalizeNodeData,
  normalizeWorkflowGraph,
  type AudioInputNodeData,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
  type ImageInputNodeData,
  type VideoInputNodeData,
  type WorkflowNodeData,
} from '@/lib/workflow-canvas';

const { requestPromptEnhancementMock } = vi.hoisted(() => ({
  requestPromptEnhancementMock: vi.fn(),
}));

vi.mock('@/app/components/enhancePromptClient', () => {
  class PromptEnhancementError extends Error {
    remainingCredits?: number;

    constructor(message: string, options?: { remainingCredits?: number }) {
      super(message);
      this.name = 'PromptEnhancementError';
      this.remainingCredits = options?.remainingCredits;
    }
  }

  return {
    PromptEnhancementError,
    requestPromptEnhancement: requestPromptEnhancementMock,
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: {
            access_token: 'test-token',
          },
        },
      })),
    },
  },
}));

function renderInteractiveInspector(
  initialNodeOrGraph: WorkflowCanvasNode | WorkflowCanvasGraph,
  options?: {
    onCreditsUpdate?: (remainingCredits: number | null) => void;
    selectedNodeId?: string;
    onDeleteEdgeSpy?: (edgeId?: string) => void;
    uploadAssetImpl?: (file: File, bucket: 'generated_images' | 'generated_videos' | 'generated_audio') => Promise<{ signedUrl: string; storagePath: string }>;
  }
) {
  const uploadAsset = vi.fn(async (file: File, bucket: 'generated_images' | 'generated_videos' | 'generated_audio') => {
    if (options?.uploadAssetImpl) {
      return options.uploadAssetImpl(file, bucket);
    }

    return {
      signedUrl: `https://example.com/${file.name || 'test'}`,
      storagePath: `${bucket}/user-1/${file.name || 'test'}`,
    };
  });
  const resolvedGraph = 'nodes' in initialNodeOrGraph
    ? initialNodeOrGraph
    : {
        ...createStarterGraph(),
        nodes: [initialNodeOrGraph],
        edges: [],
      };

  function Harness() {
    const [graph, setGraph] = useState<WorkflowCanvasGraph>(resolvedGraph);
    const selectedNode = graph.nodes.find((node) => node.id === (options?.selectedNodeId ?? graph.nodes[0]?.id)) ?? null;

    return (
      <div className="relative h-[800px]">
        <WorkflowCanvasInspector
          activePanel="parameters"
          graph={graph}
          nodePopupPosition={{ left: 160, top: 96, width: 420, caretLeft: 210 }}
          nodes={graph.nodes}
          onCreditsUpdate={options?.onCreditsUpdate}
          runAffordance={null}
          selectedEdge={null}
          selectedNode={selectedNode}
          selection={selectedNode ? { nodeIds: [selectedNode.id], edgeIds: [] } : { nodeIds: [], edgeIds: [] }}
          onClearSelection={vi.fn()}
          onDeleteEdge={(edgeId) => {
            options?.onDeleteEdgeSpy?.(edgeId);
            if (!edgeId) {
              return;
            }

            setGraph((current) => ({
              ...current,
              edges: current.edges.filter((edge) => edge.id !== edgeId),
            }));
          }}
          onDeleteNode={vi.fn()}
          onDeleteSelection={vi.fn()}
          onDuplicateSelection={vi.fn()}
          onOpenPreview={vi.fn()}
          onRunBranch={vi.fn()}
          onRunNode={vi.fn()}
          onSetError={vi.fn()}
          onPanelChange={vi.fn()}
          onUpdateNode={(nodeId, updates) => {
            setGraph((current) => ({
              ...current,
              nodes: current.nodes.map((node) => (
                node.id === nodeId
                  ? {
                      ...node,
                      data: normalizeNodeData(node.type, {
                        ...node.data,
                        ...updates,
                      } as Partial<WorkflowNodeData>),
                    }
                  : node
              )),
            }));
          }}
          onUploadAsset={uploadAsset}
        />
      </div>
    );
  }

  return {
    ...render(<Harness />),
    uploadAsset,
  };
}

describe('WorkflowNodeEditors', () => {
  beforeEach(() => {
    requestPromptEnhancementMock.mockReset();
  });

  it('renders the parameters popup and forwards title edits and clear-selection actions', () => {
    const graph = createStarterGraph();
    const node = graph.nodes[0];
    const onUpdateNode = vi.fn();
    const onClearSelection = vi.fn();

    render(
      <div className="relative h-[800px]">
        <WorkflowCanvasInspector
          activePanel="parameters"
          graph={graph}
          nodePopupPosition={{ left: 160, top: 96, width: 420, caretLeft: 210 }}
          nodes={graph.nodes}
          runAffordance={null}
          selectedEdge={null}
          selectedNode={node}
          selection={{ nodeIds: [node.id], edgeIds: [] }}
          onClearSelection={onClearSelection}
          onDeleteEdge={vi.fn()}
          onDeleteNode={vi.fn()}
          onDeleteSelection={vi.fn()}
          onDuplicateSelection={vi.fn()}
          onOpenPreview={vi.fn()}
          onRunBranch={vi.fn()}
          onRunNode={vi.fn()}
          onSetError={vi.fn()}
          onPanelChange={vi.fn()}
          onUpdateNode={onUpdateNode}
          onUploadAsset={vi.fn(async () => ({
            signedUrl: 'https://example.com/test.jpg',
            storagePath: 'generated_images/user-1/test.jpg',
          }))}
        />
      </div>
    );

    expect(screen.getByTestId('workflow-inspector-popup')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-inspector-caret')).toBeInTheDocument();
    expect(screen.getByTestId('dock-node-editor')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue(node.data.title), {
      target: { value: 'Updated prompt title' },
    });

      expect(onUpdateNode).toHaveBeenCalledWith(
      node.id,
      expect.objectContaining({ title: 'Updated prompt title' })
    );

    fireEvent.click(screen.getByRole('button', { name: /clear selection/i }));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it('keeps node selection overlay-free until the popup is explicitly opened elsewhere', () => {
    const graph = createStarterGraph();
    const node = graph.nodes[0];

    render(
      <div className="relative h-[800px]">
        <WorkflowCanvasInspector
          activePanel={null}
          graph={graph}
          nodePopupPosition={null}
          nodes={graph.nodes}
          runAffordance={null}
          selectedEdge={null}
          selectedNode={node}
          selection={{ nodeIds: [node.id], edgeIds: [] }}
          onClearSelection={vi.fn()}
          onDeleteEdge={vi.fn()}
          onDeleteNode={vi.fn()}
          onDeleteSelection={vi.fn()}
          onDuplicateSelection={vi.fn()}
          onOpenPreview={vi.fn()}
          onRunBranch={vi.fn()}
          onRunNode={vi.fn()}
          onSetError={vi.fn()}
          onPanelChange={vi.fn()}
          onUpdateNode={vi.fn()}
          onUploadAsset={vi.fn(async () => ({
            signedUrl: 'https://example.com/test.jpg',
            storagePath: 'generated_images/user-1/test.jpg',
          }))}
        />
      </div>
    );

    expect(screen.queryByTestId('workflow-inspector-popup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dock-node-editor')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workflow-inspector-menu')).not.toBeInTheDocument();
  });

  it('keeps the connection menu on the right for selected edges', () => {
    const graph = createStarterGraph();
    const edge = graph.edges[0];
    const onPanelChange = vi.fn();

    render(
      <div className="relative h-[800px]">
        <WorkflowCanvasInspector
          activePanel={null}
          graph={graph}
          nodePopupPosition={null}
          nodes={graph.nodes}
          runAffordance={null}
          selectedEdge={edge}
          selectedNode={null}
          selection={{ nodeIds: [], edgeIds: [edge.id] }}
          onClearSelection={vi.fn()}
          onDeleteEdge={vi.fn()}
          onDeleteNode={vi.fn()}
          onDeleteSelection={vi.fn()}
          onDuplicateSelection={vi.fn()}
          onOpenPreview={vi.fn()}
          onRunBranch={vi.fn()}
          onRunNode={vi.fn()}
          onSetError={vi.fn()}
          onPanelChange={onPanelChange}
          onUpdateNode={vi.fn()}
          onUploadAsset={vi.fn(async () => ({
            signedUrl: 'https://example.com/test.jpg',
            storagePath: 'generated_images/user-1/test.jpg',
          }))}
        />
      </div>
    );

    expect(screen.getByTestId('workflow-inspector-menu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /connection/i }));
    expect(onPanelChange).toHaveBeenCalledWith('connection');
  });

  it('updates image-node fields when the model changes', () => {
    const node = createWorkflowNode('image-generate', { x: 0, y: 0 });

    renderInteractiveInspector(node);

    expect(screen.getByRole('option', { name: 'GPT Image 2' })).toBeInTheDocument();

    const googleSearch = screen.getByLabelText(/google search grounding/i) as HTMLInputElement;
    expect(googleSearch).not.toBeChecked();

    fireEvent.click(googleSearch);
    expect(screen.getByLabelText(/google search grounding/i)).toBeChecked();

    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'nano-banana-pro' },
    });

    expect(screen.queryByLabelText(/google search grounding/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '1:4' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'nano-banana-2' },
    });

    expect(screen.getByLabelText(/google search grounding/i)).not.toBeChecked();

    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'gpt-image-2' },
    });
    expect(screen.queryByLabelText(/google search grounding/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Output format')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Aspect ratio'), {
      target: { value: 'auto' },
    });
    expect(Array.from((screen.getByLabelText('Resolution') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['1K']);
  });

  it('shows image-reference limits and invalid-state guidance when the selected model is over capacity', () => {
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const imageInputs = Array.from({ length: 9 }, (_, index) => createWorkflowNode('image-input', { x: 0, y: index * 80 }));
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...imageNode,
          data: normalizeNodeData('image-generate', {
            ...imageNode.data,
            model: 'nano-banana-pro',
          }),
        },
        ...imageInputs,
      ],
      edges: imageInputs.map((inputNode, index) => ({
        id: `image-ref-${index}`,
        source: inputNode.id,
        target: imageNode.id,
        sourceHandle: 'image',
        targetHandle: 'reference-image',
      })),
    });

    renderInteractiveInspector(graph, { selectedNodeId: imageNode.id });

    expect(screen.getByText(/capabilities & limits/i)).toBeInTheDocument();
    expect(screen.getByText('Image refs')).toBeInTheDocument();
    expect(screen.getAllByText('9/8').length).toBeGreaterThan(0);
    expect(screen.getByText(/supports up to 8 total image references in workflows/i)).toBeInTheDocument();
  });

  it('shows inherited source handles in image-generator references instead of inline handle editors', () => {
    const imageSource = createWorkflowNode('image-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...imageSource,
          data: normalizeNodeData('image-input', {
            ...imageSource.data,
            title: 'Hero Product',
            imageUrl: 'https://example.com/hero.png',
            referenceHandle: '@hero_product',
          }),
        },
        imageNode,
      ],
      edges: [
        { id: 'image-ref', source: imageSource.id, target: imageNode.id, sourceHandle: 'image', targetHandle: 'image-reference' },
      ],
    });

    renderInteractiveInspector(graph, { selectedNodeId: imageNode.id });

    expect(screen.getAllByText(/^image references$/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/source:/i)).toBeInTheDocument();
    expect(screen.getByText('Hero Product')).toBeInTheDocument();
    expect(screen.getByText('@hero_product')).toBeInTheDocument();
    expect(screen.getByText(/^Source handle$/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/hero product handle/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/add named elements/i)).not.toBeInTheDocument();
  });

  it('updates source-owned reference handles on image-input nodes', () => {
    const imageSource = createWorkflowNode('image-input', { x: 0, y: 0 });

    renderInteractiveInspector(imageSource);

    fireEvent.change(screen.getByLabelText('Reference handle'), {
      target: { value: 'lead_product' },
    });

    expect(screen.getByDisplayValue('@lead_product')).toBeInTheDocument();
    expect(screen.getByText(/optional global @handle for this image source/i)).toBeInTheDocument();
  });

  it('shows Seedance asset prep controls on input nodes and persists asset metadata edits', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        assetId: 'asset-123',
        status: 'processing',
        sourceUrl: 'https://example.com/hero.png',
        lastCheckedAt: '2026-04-04T00:00:00.000Z',
      }),
    })));

    const baseImageSource = createWorkflowNode('image-input', { x: 0, y: 0 });
    const imageSource = {
      ...baseImageSource,
      data: normalizeNodeData('image-input', {
        ...baseImageSource.data,
        imageUrl: 'https://example.com/hero.png',
        seedanceAsset: {
          assetId: null,
          assetType: 'Image',
          status: 'idle',
          sourceUrl: 'https://example.com/hero.png',
          error: null,
          lastCheckedAt: null,
        },
      }),
    };

    renderInteractiveInspector(imageSource);

    expect(screen.getByText(/track whether this uploaded source has already been prepared for Seedance 2 references/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /prepare asset/i }));

    await waitFor(() => {
      expect(screen.getByText('asset-123')).toBeInTheDocument();
      expect(screen.getAllByText('Processing').length).toBeGreaterThan(0);
    });
  });

  it('removes connected named-element edges from the inspector', () => {
    const onDeleteEdgeSpy = vi.fn();
    const imageSource = createWorkflowNode('image-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...imageSource,
          data: normalizeNodeData('image-input', {
            ...imageSource.data,
            title: 'Hero Product',
            imageUrl: 'https://example.com/hero.png',
            referenceHandle: '@hero_product',
          }),
        },
        imageNode,
      ],
      edges: [
        { id: 'image-ref', source: imageSource.id, target: imageNode.id, sourceHandle: 'image', targetHandle: 'image-reference' },
      ],
    });

    renderInteractiveInspector(graph, {
      selectedNodeId: imageNode.id,
      onDeleteEdgeSpy,
    });

    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));

    expect(onDeleteEdgeSpy).toHaveBeenCalledWith('image-ref');
    expect(screen.queryByText('@hero_product')).not.toBeInTheDocument();
  });

  it('shows legacy handled references as compatibility-only state', () => {
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...imageNode,
          data: normalizeNodeData('image-generate', {
            ...imageNode.data,
            elements: [
              {
                id: 'legacy-hero',
                displayName: 'Legacy Hero',
                handle: '@legacy_hero',
                storagePath: 'generated_images/user-1/legacy-hero.jpg',
                url: 'https://example.com/legacy-hero.jpg',
                sourceGenerationId: null,
              },
            ],
          }),
        },
      ],
      edges: [],
    });

    renderInteractiveInspector(graph, { selectedNodeId: imageNode.id });

    expect(screen.getByText(/legacy handled references/i)).toBeInTheDocument();
    expect(screen.getByText('Legacy Hero')).toBeInTheDocument();
    expect(screen.getByText('@legacy_hero')).toBeInTheDocument();
  });

  it('updates video-node fields when the model changes', () => {
    const node = createWorkflowNode('video-generate', { x: 0, y: 0 });

    renderInteractiveInspector(node);

    expect(screen.getByLabelText(/quality mode/i)).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Duration' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Resolution')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/fixed lens/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'seedance-1.5-pro' },
    });

    expect(screen.queryByLabelText(/quality mode/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Resolution')).toBeInTheDocument();
    expect(screen.getByLabelText(/fixed lens/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Duration').tagName).toBe('SELECT');

    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'seedance-2' },
    });

    expect(screen.getByText(/Seedance references/i)).toBeInTheDocument();
    expect(screen.getAllByText(/prepared assets/i).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/fixed lens/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Duration').tagName).toBe('INPUT');

    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'veo-3.1' },
    });

    expect(screen.getByLabelText(/model variant/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Resolution')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/native audio/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/fixed lens/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Duration' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Duration')).not.toBeInTheDocument();
    expect(screen.getByText('8 sec fixed')).toBeInTheDocument();
  });

  it('shows Seedance 2 readiness summaries for connected reference assets', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const imageInput = createWorkflowNode('image-input', { x: 0, y: 120 });
    const videoInput = createWorkflowNode('video-input', { x: 0, y: 240 });
    const audioInput = createWorkflowNode('audio-input', { x: 0, y: 360 });
    const seedanceNode = createWorkflowNode('video-generate', { x: 240, y: 0 });

    const graph = normalizeWorkflowGraph({
      nodes: [
        promptNode,
        {
          ...imageInput,
          data: normalizeNodeData('image-input', {
            ...imageInput.data,
            imageUrl: 'https://example.com/reference.jpg',
            seedanceAsset: {
              ...(imageInput.data as ImageInputNodeData).seedanceAsset,
              assetId: 'asset-image',
              status: 'active',
              sourceUrl: 'https://example.com/reference.jpg',
            },
          }),
        },
        {
          ...videoInput,
          data: normalizeNodeData('video-input', {
            ...videoInput.data,
            videoUrl: 'https://example.com/reference.mp4',
            durationSeconds: 6,
            seedanceAsset: {
              ...(videoInput.data as VideoInputNodeData).seedanceAsset,
              assetId: 'asset-video',
              status: 'processing',
              sourceUrl: 'https://example.com/reference.mp4',
            },
          }),
        },
        {
          ...audioInput,
          data: normalizeNodeData('audio-input', {
            ...audioInput.data,
            audioUrl: 'https://example.com/reference.mp3',
            seedanceAsset: {
              ...(audioInput.data as AudioInputNodeData).seedanceAsset,
              assetId: null,
              status: 'idle',
              sourceUrl: 'https://example.com/reference.mp3',
            },
          }),
        },
        {
          ...seedanceNode,
          data: normalizeNodeData('video-generate', {
            ...seedanceNode.data,
            model: 'seedance-2-fast',
          }),
        },
      ],
      edges: [
        { id: 'prompt', source: promptNode.id, target: seedanceNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'image', source: imageInput.id, target: seedanceNode.id, sourceHandle: 'image', targetHandle: 'reference-image' },
        { id: 'video', source: videoInput.id, target: seedanceNode.id, sourceHandle: 'video', targetHandle: 'reference-video' },
        { id: 'audio', source: audioInput.id, target: seedanceNode.id, sourceHandle: 'audio', targetHandle: 'reference-audio' },
      ],
    });

    renderInteractiveInspector(graph, { selectedNodeId: seedanceNode.id });

    expect(screen.getByText(/Seedance references/i)).toBeInTheDocument();
    expect(screen.getByText(/1\/3 ready/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Image refs/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Video refs/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Audio refs/i).length).toBeGreaterThan(0);
  });

  it('shows Kling video reference handles in the video node inspector', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const videoInput = createWorkflowNode('video-input', { x: 0, y: 120 });
    const klingNode = createWorkflowNode('video-generate', { x: 240, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        promptNode,
        {
          ...videoInput,
          data: normalizeNodeData('video-input', {
            ...videoInput.data,
            title: 'Motion ref',
            videoUrl: 'https://example.com/reference.mp4',
            storagePath: 'uploads/user-1/reference.mp4',
          }),
        },
        {
          ...klingNode,
          data: normalizeNodeData('video-generate', {
            ...klingNode.data,
            model: 'kling-3.0-video',
          }),
        },
      ],
      edges: [
        { id: 'prompt', source: promptNode.id, target: klingNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'video', source: videoInput.id, target: klingNode.id, sourceHandle: 'video', targetHandle: 'reference-video' },
      ],
    });

    renderInteractiveInspector(graph, { selectedNodeId: klingNode.id });

    expect(screen.getByText(/Kling video elements/i)).toBeInTheDocument();
    expect(screen.getByText('@motion_ref')).toBeInTheDocument();
    expect(screen.getAllByText(/1 connected/i).length).toBeGreaterThan(0);
  });

  it('shows workflow-video limits and unsupported standalone feature messaging', () => {
    const videoNode = createWorkflowNode('video-generate', { x: 240, y: 0 });
    const imageInput = createWorkflowNode('image-input', { x: 0, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [videoNode, imageInput],
      edges: [
        { id: 'video-start-1', source: imageInput.id, target: videoNode.id, sourceHandle: 'image', targetHandle: 'start-frame' },
      ],
    });

    renderInteractiveInspector(graph, { selectedNodeId: videoNode.id });

    expect(screen.getByText(/capabilities & limits/i)).toBeInTheDocument();
    expect(screen.getAllByText('Start frame').length).toBeGreaterThan(0);
    expect(screen.getByText('1/1')).toBeInTheDocument();
    expect(screen.getByText(/connect one image to Start frame, then connect another image to End frame/i)).toBeInTheDocument();
    expect(
      screen.getByText(/single-shot video uses the shared upstream prompt text unless you switch into multi-shot/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Image references$/i)).not.toBeInTheDocument();
  });

  it('shows motion validation errors and the reference-video limit when a connected clip is too long', () => {
    const motionNode = createWorkflowNode('motion-generate', { x: 240, y: 0 });
    const imageInput = createWorkflowNode('image-input', { x: 0, y: 0 });
    const videoInput = createWorkflowNode('video-input', { x: 0, y: 160 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        motionNode,
        imageInput,
        {
          ...videoInput,
          data: normalizeNodeData('video-input', {
            ...videoInput.data,
            durationSeconds: 31,
          }),
        },
      ],
      edges: [
        { id: 'motion-image-1', source: imageInput.id, target: motionNode.id, sourceHandle: 'image', targetHandle: 'reference-image' },
        { id: 'motion-video-1', source: videoInput.id, target: motionNode.id, sourceHandle: 'video', targetHandle: 'reference-video' },
      ],
    });

    renderInteractiveInspector(graph, { selectedNodeId: motionNode.id });

    expect(screen.getByText(/reference video limit/i)).toBeInTheDocument();
    expect(screen.getByText('30s')).toBeInTheDocument();
    expect(screen.getByText(/exceeds the 30s motion-control limit/i)).toBeInTheDocument();
  });

  it('shows the detected duration on uploaded video-input nodes when metadata is known', () => {
    const videoInput = createWorkflowNode('video-input', { x: 0, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...videoInput,
          data: normalizeNodeData('video-input', {
            ...videoInput.data,
            durationSeconds: 12.4,
            videoUrl: 'https://example.com/reference.mp4',
            storagePath: 'generated_videos/user-1/reference.mp4',
          }),
        },
      ],
      edges: [],
    });

    renderInteractiveInspector(graph, { selectedNodeId: videoInput.id });

    expect(screen.getByText('Detected duration: 12.4s')).toBeInTheDocument();
  });

  it('renders a custom clickable upload tile for image inputs and uploads selected files', async () => {
    const imageInput = createWorkflowNode('image-input', { x: 0, y: 0 });
    const view = renderInteractiveInspector(imageInput);
    const file = new File(['image-bytes'], 'hero.png', { type: 'image/png' });

    const uploadTile = screen.getByText('Click to upload image').closest('label');
    expect(uploadTile).toHaveClass('cursor-pointer');

    fireEvent.change(screen.getByLabelText('Upload image file'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(view.uploadAsset).toHaveBeenCalledWith(file, 'generated_images');
    });

    const previewImage = view.container.querySelector('img');
    expect(previewImage).not.toBeNull();
    expect(previewImage?.getAttribute('src')).toContain('/api/media?');
  });

  it('renders a custom clickable upload tile for audio inputs and uploads selected files', async () => {
    const audioInput = createWorkflowNode('audio-input', { x: 0, y: 0 });
    const view = renderInteractiveInspector(audioInput);
    const file = new File(['audio-bytes'], 'track.mp3', { type: 'audio/mpeg' });

    const uploadTile = screen.getByText('Click to upload audio').closest('label');
    expect(uploadTile).toHaveClass('cursor-pointer');

    fireEvent.change(screen.getByLabelText('Upload audio file'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(view.uploadAsset).toHaveBeenCalledWith(file, 'generated_audio');
    });

    expect(view.container.querySelector('audio')).not.toBeNull();
  });

  it('renders a custom clickable upload tile for video inputs and keeps duration detection after upload', async () => {
    const videoInput = createWorkflowNode('video-input', { x: 0, y: 0 });
    const view = renderInteractiveInspector(videoInput);
    const file = new File(['video-bytes'], 'reference.mp4', { type: 'video/mp4' });
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const originalCreateElement = document.createElement.bind(document);

    URL.createObjectURL = vi.fn(() => 'blob:workflow-video') as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;

    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'video') {
        const previewVideo = originalCreateElement('video') as HTMLVideoElement;
        Object.defineProperty(previewVideo, 'duration', {
          configurable: true,
          get: () => 12.4,
        });
        Object.defineProperty(previewVideo, 'src', {
          configurable: true,
          get: () => 'blob:workflow-video',
          set: () => {
            setTimeout(() => {
              previewVideo.onloadedmetadata?.(new Event('loadedmetadata'));
            }, 0);
          },
        });
        previewVideo.load = vi.fn();
        return previewVideo;
      }

      return originalCreateElement(tagName);
    }) as typeof document.createElement);

    const uploadTile = screen.getByText('Click to upload video').closest('label');
    expect(uploadTile).toHaveClass('cursor-pointer');

    fireEvent.change(screen.getByLabelText('Upload video file'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(view.uploadAsset).toHaveBeenCalledWith(file, 'generated_videos');
    });

    expect(screen.getByText('Detected duration: 12.4s')).toBeInTheDocument();
    expect(view.container.querySelector('video')).not.toBeNull();

    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('shows workflow prompt mention suggestions for reachable handled refs and inserts the selected handle', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const handledSource = createWorkflowNode('image-input', { x: 0, y: 140 });
    const anonymousSource = createWorkflowNode('image-input', { x: 0, y: 280 });
    const imageNode = createWorkflowNode('image-generate', { x: 260, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        promptNode,
        {
          ...handledSource,
          data: normalizeNodeData('image-input', {
            ...handledSource.data,
            title: 'Hero Product',
            imageUrl: 'https://example.com/hero.png',
            referenceHandle: '@hero_product',
          }),
        },
        {
          ...anonymousSource,
          data: normalizeNodeData('image-input', {
            ...anonymousSource.data,
            title: 'Mood Board',
            imageUrl: 'https://example.com/mood.png',
          }),
        },
        imageNode,
      ],
      edges: [
        { id: 'prompt-image', source: promptNode.id, target: imageNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'handled-ref', source: handledSource.id, target: imageNode.id, sourceHandle: 'image', targetHandle: 'image-reference' },
        { id: 'anonymous-ref', source: anonymousSource.id, target: imageNode.id, sourceHandle: 'image', targetHandle: 'image-reference' },
      ],
    });

    renderInteractiveInspector(graph, { selectedNodeId: promptNode.id });

    const textarea = screen.getByLabelText('Prompt') as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: {
        value: 'Describe @',
        selectionStart: 10,
        selectionEnd: 10,
      },
    });

    expect(screen.getByText(/insert reference/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /insert @hero_product/i })).toBeInTheDocument();
    expect(screen.queryByText('Mood Board')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /insert @hero_product/i }));

    expect(screen.getByDisplayValue('Describe @hero_product')).toBeInTheDocument();
  });

  it('does not open workflow prompt mention suggestions when no handled refs are reachable', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const imageSource = createWorkflowNode('image-input', { x: 0, y: 140 });
    const imageNode = createWorkflowNode('image-generate', { x: 260, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        promptNode,
        {
          ...imageSource,
          data: normalizeNodeData('image-input', {
            ...imageSource.data,
            title: 'Mood Board',
            imageUrl: 'https://example.com/mood.png',
          }),
        },
        imageNode,
      ],
      edges: [
        { id: 'prompt-image', source: promptNode.id, target: imageNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'anonymous-ref', source: imageSource.id, target: imageNode.id, sourceHandle: 'image', targetHandle: 'image-reference' },
      ],
    });

    renderInteractiveInspector(graph, { selectedNodeId: promptNode.id });

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: {
        value: 'Describe @',
        selectionStart: 10,
        selectionEnd: 10,
      },
    });

    expect(screen.queryByText(/insert reference/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /insert @/i })).not.toBeInTheDocument();
  });

  it('disables prompt enhancement when the prompt does not feed image, video, or motion generation', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const voiceoverNode = createWorkflowNode('voiceover-generate', { x: 240, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [promptNode, voiceoverNode],
      edges: [
        { id: 'prompt-voice', source: promptNode.id, target: voiceoverNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
      ],
    });

    renderInteractiveInspector(graph, { selectedNodeId: promptNode.id });

    expect(screen.getByRole('button', { name: /enhance prompt/i })).toBeDisabled();
    expect(
      screen.getByText(/prompt enhancement works when this prompt feeds an image, video, or motion generator/i)
    ).toBeInTheDocument();
  });

  it('enhances immediately when there is a single supported downstream target', async () => {
    const onCreditsUpdate = vi.fn();
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [promptNode, imageNode],
      edges: [
        { id: 'prompt-image', source: promptNode.id, target: imageNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
      ],
    });

    requestPromptEnhancementMock.mockResolvedValue({
      enhancedPrompt: 'Refined still-image prompt',
      remainingCredits: 48,
    });

    renderInteractiveInspector(graph, {
      onCreditsUpdate,
      selectedNodeId: promptNode.id,
    });

    fireEvent.click(screen.getByRole('button', { name: /enhance prompt/i }));

    await waitFor(() => {
      expect(requestPromptEnhancementMock).toHaveBeenCalledWith(expect.objectContaining({
        medium: 'image',
        selectedModel: 'nano-banana-2',
        context: expect.objectContaining({
          modelId: 'nano-banana-2',
          aspectRatio: '9:16',
          resolution: '1K',
          googleSearch: false,
          referenceImageCount: 0,
        }),
      }));
    });

    expect(screen.getByDisplayValue('Refined still-image prompt')).toBeInTheDocument();
    expect(onCreditsUpdate).toHaveBeenCalledWith(48);
  });

  it('opens a target picker for multiple supported branches and enhances against the chosen branch', async () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const imageInputNode = createWorkflowNode('image-input', { x: 240, y: 180 });
    const videoNode = createWorkflowNode('video-generate', { x: 240, y: 360 });
    const graph = normalizeWorkflowGraph({
      nodes: [promptNode, imageNode, imageInputNode, videoNode],
      edges: [
        { id: 'prompt-image', source: promptNode.id, target: imageNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'prompt-video', source: promptNode.id, target: videoNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'image-ref-video', source: imageInputNode.id, target: videoNode.id, sourceHandle: 'image', targetHandle: 'reference-image' },
      ],
    });

    requestPromptEnhancementMock.mockResolvedValue({
      enhancedPrompt: 'Enhanced video branch prompt',
      remainingCredits: 61,
    });

    renderInteractiveInspector(graph, { selectedNodeId: promptNode.id });

    fireEvent.click(screen.getByRole('button', { name: /enhance prompt/i }));

    expect(requestPromptEnhancementMock).not.toHaveBeenCalled();
    expect(screen.getByText(/choose target branch/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enhance prompt for image generator/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enhance prompt for video generator/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /enhance prompt for video generator/i }));

    await waitFor(() => {
      expect(requestPromptEnhancementMock).toHaveBeenCalledWith(expect.objectContaining({
        medium: 'video',
        selectedModel: 'kling-3.0-video',
        context: expect.objectContaining({
          modelId: 'kling-3.0-video',
          aspectRatio: '9:16',
          duration: 5,
          mode: 'std',
          sound: false,
          hasStartImage: true,
          referenceImageCount: 1,
        }),
      }));
    });

    expect(screen.getByDisplayValue('Enhanced video branch prompt')).toBeInTheDocument();
  });
});
