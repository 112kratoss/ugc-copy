import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkflowCanvasInspector } from '@/app/create-workflow/WorkflowNodeEditors';
import {
  createStarterGraph,
  createWorkflowNode,
  normalizeNodeData,
  normalizeWorkflowGraph,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
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

function renderInteractiveInspector(
  initialNodeOrGraph: WorkflowCanvasNode | WorkflowCanvasGraph,
  options?: {
    onCreditsUpdate?: (remainingCredits: number | null) => void;
    selectedNodeId?: string;
    onDeleteEdgeSpy?: (edgeId?: string) => void;
  }
) {
  const uploadAsset = vi.fn(async () => ({
    signedUrl: 'https://example.com/test.jpg',
    storagePath: 'generated_images/user-1/test.jpg',
  }));
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

  return render(<Harness />);
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
          onDeleteEdge={(edgeId) => {
            options?.onDeleteEdgeSpy?.(edgeId);
            if (!edgeId) {
              return;
            }

            setGraph((current) => ({
              ...current,
              edges: current.edges.filter((edge) => edge.id !== edgeId),
              nodes: current.nodes,
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
    expect(screen.getByText('Connected refs')).toBeInTheDocument();
    expect(screen.getAllByText('9/8').length).toBeGreaterThan(0);
    expect(screen.getByText(/supports up to 8 total reference images in workflows/i)).toBeInTheDocument();
  });

  it('shows connected named elements for image generators instead of an upload widget', () => {
    const imageSource = createWorkflowNode('image-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...imageSource,
          data: {
            ...imageSource.data,
            title: 'Hero Product',
            imageUrl: 'https://example.com/hero.png',
          },
        },
        imageNode,
      ],
      edges: [
        { id: 'element-edge', source: imageSource.id, target: imageNode.id, sourceHandle: 'image', targetHandle: 'element-image' },
      ],
    });

    renderInteractiveInspector(graph, { selectedNodeId: imageNode.id });

    expect(screen.getAllByText(/connected named elements/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/source:/i)).toBeInTheDocument();
    expect(screen.getByText('Hero Product')).toBeInTheDocument();
    expect(screen.getByDisplayValue('@hero_product')).toBeInTheDocument();
    expect(screen.queryByLabelText(/add named elements/i)).not.toBeInTheDocument();
  });

  it('updates connected element handles inline for image generators', () => {
    const imageSource = createWorkflowNode('image-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...imageSource,
          data: {
            ...imageSource.data,
            title: 'Hero Product',
            imageUrl: 'https://example.com/hero.png',
          },
        },
        imageNode,
      ],
      edges: [
        { id: 'element-edge', source: imageSource.id, target: imageNode.id, sourceHandle: 'image', targetHandle: 'element-image' },
      ],
    });

    renderInteractiveInspector(graph, { selectedNodeId: imageNode.id });

    fireEvent.change(screen.getByLabelText(/hero product handle/i), {
      target: { value: '@lead_product' },
    });

    expect(screen.getByDisplayValue('@lead_product')).toBeInTheDocument();
    expect(screen.getByText('@lead_product')).toBeInTheDocument();
  });

  it('removes connected named-element edges from the inspector', () => {
    const onDeleteEdgeSpy = vi.fn();
    const imageSource = createWorkflowNode('image-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...imageSource,
          data: {
            ...imageSource.data,
            title: 'Hero Product',
            imageUrl: 'https://example.com/hero.png',
          },
        },
        imageNode,
      ],
      edges: [
        { id: 'element-edge', source: imageSource.id, target: imageNode.id, sourceHandle: 'image', targetHandle: 'element-image' },
      ],
    });

    renderInteractiveInspector(graph, {
      selectedNodeId: imageNode.id,
      onDeleteEdgeSpy,
    });

    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));

    expect(onDeleteEdgeSpy).toHaveBeenCalledWith('element-edge');
    expect(screen.queryByDisplayValue('@hero_product')).not.toBeInTheDocument();
  });

  it('shows legacy attached elements as compatibility-only state', () => {
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

    expect(screen.getByText(/legacy attached elements/i)).toBeInTheDocument();
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

  it('shows workflow-video limits and unsupported standalone feature messaging', () => {
    const videoNode = createWorkflowNode('video-generate', { x: 240, y: 0 });
    const imageInput = createWorkflowNode('image-input', { x: 0, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [videoNode, imageInput],
      edges: [
        { id: 'video-ref-1', source: imageInput.id, target: videoNode.id, sourceHandle: 'image', targetHandle: 'reference-image' },
      ],
    });

    renderInteractiveInspector(graph, { selectedNodeId: videoNode.id });

    expect(screen.getByText(/capabilities & limits/i)).toBeInTheDocument();
    expect(screen.getByText('1/1')).toBeInTheDocument();
    expect(screen.getByText(/frames mode uses graph-connected start and optional end frame inputs/i)).toBeInTheDocument();
    expect(
      screen.getByText(/single-shot video uses the shared upstream prompt text unless you switch into multi-shot/i)
    ).toBeInTheDocument();
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
        selectedModel: 'kling-3.0/video',
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
