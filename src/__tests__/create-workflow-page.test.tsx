import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateWorkflowPage from '@/app/create-workflow/page';
import { createStarterGraph, type WorkflowCanvasRecord } from '@/lib/workflow-canvas';

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockRouter = {
  push: mockPush,
  replace: mockReplace,
};

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: { access_token: 'test-token' },
        },
      })),
      getUser: vi.fn(async () => ({
        data: {
          user: { id: 'user-1' },
        },
      })),
    },
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(),
        createSignedUrl: vi.fn(),
      })),
    },
  },
}));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  const latestPropsRef: { current: Record<string, unknown> | null } = { current: null };

  const flowInstance = {
    screenToFlowPosition: vi.fn(({ x, y }: { x: number; y: number }) => ({ x, y })),
    flowToScreenPosition: vi.fn((position: { x: number; y: number }) => position),
    getNode: vi.fn((id: string) => latestPropsRef.current?.nodes.find((node: { id: string }) => node.id === id)),
    fitView: vi.fn(async () => undefined),
    setViewport: vi.fn(async () => undefined),
  };

  function ReactFlow(props: Record<string, unknown>) {
    const nodes = (props.nodes as Array<{ id: string; data: { title: string } }>) || [];
    const edges = (props.edges as Array<{ id: string }>) || [];
    React.useLayoutEffect(() => {
      latestPropsRef.current = props;
      (props.onInit as ((instance: typeof flowInstance) => void) | undefined)?.(flowInstance);
    }, [props]);

    return (
      <div data-testid="reactflow-mock">
        <button
          type="button"
          data-testid="pane-click"
          onClick={() => (props.onPaneClick as ((event: Record<string, unknown>) => void) | undefined)?.({
            preventDefault() {},
            stopPropagation() {},
            clientX: 0,
            clientY: 0,
          })}
        >
          Pane click
        </button>
        <button
          type="button"
          data-testid="select-first-two-nodes"
          onClick={() =>
            (props.onSelectionChange as ((selection: { nodes: Array<{ id: string }>; edges: Array<{ id: string }> }) => void) | undefined)?.({
              nodes: nodes.slice(0, 2).map((node) => ({ id: node.id })),
              edges: [],
            })
          }
        >
          Select two nodes
        </button>
        {nodes.map((node) => (
          <div key={node.id}>
            <button
              type="button"
              data-testid={`node-select-${node.id}`}
              onClick={() =>
                (props.onSelectionChange as ((selection: { nodes: Array<{ id: string }>; edges: Array<{ id: string }> }) => void) | undefined)?.({
                  nodes: [{ id: node.id }],
                  edges: [],
                })
              }
            >
              Select {node.data.title}
            </button>
            <button
              type="button"
              data-testid={`node-context-${node.id}`}
              onClick={() =>
                (props.onNodeContextMenu as ((event: Record<string, unknown>, node: { id: string; data: { title: string } }) => void) | undefined)?.({
                  preventDefault() {},
                  stopPropagation() {},
                  clientX: 120,
                  clientY: 120,
                }, node)
              }
            >
              Node menu {node.data.title}
            </button>
          </div>
        ))}
        {edges.map((edge) => (
          <div key={edge.id}>
            <button
              type="button"
              data-testid={`edge-context-${edge.id}`}
              onClick={() =>
                (props.onEdgeContextMenu as ((event: Record<string, unknown>, edge: { id: string }) => void) | undefined)?.({
                  preventDefault() {},
                  stopPropagation() {},
                  clientX: 180,
                  clientY: 160,
                }, edge)
              }
            >
              Edge menu {edge.id}
            </button>
          </div>
        ))}
      </div>
    );
  }

  return {
    addEdge: (edge: Record<string, unknown>, current: Array<Record<string, unknown>>) => [...current, edge],
    Background: () => <div data-testid="rf-background" />,
    BackgroundVariant: { Dots: 'dots' },
    Controls: () => <div data-testid="rf-controls" />,
    Handle: () => null,
    MiniMap: () => <div data-testid="rf-minimap" />,
    Position: { Left: 'left', Right: 'right' },
    ReactFlow,
    SelectionMode: { Partial: 'partial', Full: 'full' },
    useEdgesState: (initial: Array<Record<string, unknown>>) => {
      const [state, setState] = React.useState(initial);
      return [state, setState, vi.fn()] as const;
    },
    useNodesState: (initial: Array<Record<string, unknown>>) => {
      const [state, setState] = React.useState(initial);
      return [state, setState, vi.fn()] as const;
    },
  };
});

describe('CreateWorkflowPage', () => {
  let canvas: WorkflowCanvasRecord;

  beforeEach(() => {
    canvas = {
      id: 'canvas-1',
      title: 'Workflow canvas',
      graph: createStarterGraph(),
      created_at: '2026-03-22T00:00:00.000Z',
      updated_at: '2026-03-22T00:00:00.000Z',
    };

    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/api/workflow-canvases') && method === 'GET') {
        return {
          ok: true,
          json: async () => ({ canvases: [canvas] }),
        } as Response;
      }

      if (url.includes('/api/workflow-canvases/') && method === 'PATCH') {
        const payload = JSON.parse(String(init?.body || '{}'));
        canvas = {
          ...canvas,
          title: payload.title ?? canvas.title,
          graph: payload.graph ?? canvas.graph,
          updated_at: '2026-03-22T00:01:00.000Z',
        };
        return {
          ok: true,
          json: async () => ({ canvas }),
        } as Response;
      }

      if (url.includes('/api/workflow-canvases/') && method === 'POST') {
        return {
          ok: true,
          json: async () => ({ runId: 'run-1' }),
        } as Response;
      }

      if (url.endsWith('/api/workflow-blueprint') && method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            blueprint: {
              title: 'Sample Blueprint',
              creativeStrategy: 'Lead with a quick hook.',
              hook: 'Quick demo hook',
              narrative: 'Show the before and after.',
              voiceover: 'Here is the value fast.',
              editingNotes: ['Keep cuts tight'],
              assetChecklist: ['Product closeups'],
              deliveryPlan: {
                stillImageModel: 'nano-banana-2',
                primaryModel: 'kling-3.0-video',
                motionModel: 'kling-3.0',
                recommendedSequence: ['Still', 'Video'],
              },
              shots: [],
            },
            remainingCredits: 42,
          }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens a floating node editor on single selection and closes it from the pane', async () => {
    render(<CreateWorkflowPage />);
    await screen.findByText(new Date(canvas.updated_at).toLocaleString());

    fireEvent.click(await screen.findByTestId(`node-select-${canvas.graph.nodes[0].id}`));

    expect(screen.getByTestId('floating-node-editor')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pane-click'));

    await waitFor(() => {
      expect(screen.queryByTestId('floating-node-editor')).not.toBeInTheDocument();
    });
  });

  it('deletes a selected connection from the context menu', async () => {
    render(<CreateWorkflowPage />);
    await screen.findByText(new Date(canvas.updated_at).toLocaleString());

    const edgeButtonsBefore = await screen.findAllByTestId(/edge-context-/);
    fireEvent.click(await screen.findByTestId(`edge-context-${canvas.graph.edges[0].id}`));

    expect(screen.getByRole('button', { name: /delete connection/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /delete connection/i }));

    await waitFor(() => {
      expect(screen.getAllByTestId(/edge-context-/)).toHaveLength(edgeButtonsBefore.length - 1);
    });
  });

  it('preserves multi-selection when right-clicking a selected node', async () => {
    render(<CreateWorkflowPage />);
    await screen.findByText(new Date(canvas.updated_at).toLocaleString());

    fireEvent.click(await screen.findByTestId('select-first-two-nodes'));
    expect(screen.getByTestId('canvas-selection-hud')).toHaveTextContent('2 nodes');

    fireEvent.click(await screen.findByTestId(`node-context-${canvas.graph.nodes[0].id}`));

    expect(screen.getByTestId('canvas-selection-hud')).toHaveTextContent('2 nodes');
    expect(screen.getByRole('button', { name: /duplicate selected/i })).toBeInTheDocument();
  });

  it('opens and closes the planner drawer while preserving brief state', async () => {
    render(<CreateWorkflowPage />);
    await screen.findByText(new Date(canvas.updated_at).toLocaleString());

    fireEvent.click(await screen.findByRole('button', { name: /^planner$/i }));
    expect(await screen.findByTestId('planner-assistant-drawer')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/brand name/i), {
      target: { value: 'Acme Labs' },
    });

    fireEvent.click(screen.getByRole('button', { name: /close planner drawer/i }));

    await waitFor(() => {
      expect(screen.queryByTestId('planner-assistant-drawer')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^planner$/i }));
    expect(await screen.findByDisplayValue('Acme Labs')).toBeInTheDocument();
  });

  it('duplicates the current node selection with the keyboard shortcut', async () => {
    render(<CreateWorkflowPage />);
    await screen.findByText(new Date(canvas.updated_at).toLocaleString());

    fireEvent.click(await screen.findByTestId('select-first-two-nodes'));
    expect(screen.getByTestId('canvas-selection-hud')).toHaveTextContent('2 nodes');
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^duplicate$/i }).length).toBeGreaterThan(0);
    });
    const nodeButtonsBefore = await screen.findAllByTestId(/node-select-/);

    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });

    await waitFor(() => {
      expect(screen.getAllByTestId(/node-select-/)).toHaveLength(nodeButtonsBefore.length + 2);
    });
  });
});
