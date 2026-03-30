import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateWorkflowPage from '@/app/create-workflow/page';
import { createStarterGraph, type WorkflowCanvasRecord } from '@/lib/workflow-canvas';

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockRefreshSessionState = vi.fn(async () => undefined);
const mockUpdateCredits = vi.fn();
const mockRouter = {
  push: mockPush,
  replace: mockReplace,
};

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: {
      access_token: 'test-token',
      user: { id: 'user-1' },
    },
    user: { id: 'user-1' },
    credits: 25,
    isLoading: false,
    updateCredits: mockUpdateCredits,
    refreshSessionState: mockRefreshSessionState,
  }),
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
  const latestPropsRef: { current: { nodes?: Array<{ id: string }> } | null } = { current: null };

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
    const didInitRef = React.useRef(false);

    React.useLayoutEffect(() => {
      latestPropsRef.current = props;
    }, [props]);

    React.useEffect(() => {
      if (didInitRef.current) {
        return;
      }

      didInitRef.current = true;
      (props.onInit as ((instance: typeof flowInstance) => void) | undefined)?.(flowInstance);
    }, [props.onInit]);

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
    applyEdgeChanges: (_changes: Array<Record<string, unknown>>, current: Array<Record<string, unknown>>) => current,
    applyNodeChanges: (_changes: Array<Record<string, unknown>>, current: Array<Record<string, unknown>>) => current,
    Background: () => <div data-testid="rf-background" />,
    BackgroundVariant: { Dots: 'dots' },
    Controls: () => <div data-testid="rf-controls" />,
    Handle: () => null,
    MiniMap: () => <div data-testid="rf-minimap" />,
    Position: { Left: 'left', Right: 'right' },
    ReactFlow,
    SelectionMode: { Partial: 'partial', Full: 'full' },
  };
});

describe('CreateWorkflowPage', () => {
  let canvas: WorkflowCanvasRecord;

  async function renderLoadedPage() {
    const fetchMock = global.fetch as unknown as {
      mock: { calls: Array<[unknown, RequestInit | undefined]> };
    };

    render(<CreateWorkflowPage />);

    await screen.findAllByTestId(/node-select-/);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url, init]) =>
          String(url).endsWith(`/api/workflow-canvases/${canvas.id}`) && (init?.method || 'GET') === 'GET'
        )
      ).toBe(true);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    canvas = {
      id: 'canvas-1',
      title: 'Workflow canvas',
      graph: createStarterGraph(),
      created_at: '2026-03-22T00:00:00.000Z',
      updated_at: '2026-03-22T00:00:00.000Z',
      revision: 0,
    };

    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/api/workflow-canvases') && method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            canvases: [{
              id: canvas.id,
              title: canvas.title,
              updated_at: canvas.updated_at,
              revision: canvas.revision,
            }],
          }),
        } as Response;
      }

      if (url.endsWith(`/api/workflow-canvases/${canvas.id}`) && method === 'GET') {
        return {
          ok: true,
          json: async () => ({ canvas }),
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

      if (url.endsWith('/api/workflow-canvases') && method === 'POST') {
        canvas = {
          ...canvas,
          id: 'canvas-2',
          title: 'Workflow 2',
          updated_at: '2026-03-22T00:02:00.000Z',
          revision: 0,
        };
        return {
          ok: true,
          json: async () => ({ canvas }),
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

  it('opens and closes the planner drawer while preserving brief state', async () => {
    await renderLoadedPage();

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

  it('shows duplicate controls in the selection hud for multi-select', async () => {
    await renderLoadedPage();

    fireEvent.click(await screen.findByTestId('select-first-two-nodes'));
    const selectionHud = await screen.findByTestId('canvas-selection-hud');
    expect(selectionHud).toHaveTextContent('2 nodes');
    expect(selectionHud).toHaveTextContent('Duplicate');
    expect(selectionHud).toHaveTextContent('Delete');
  });

  it('does not autosave selection-only changes', async () => {
    await renderLoadedPage();

    const fetchMock = global.fetch as unknown as {
      mockClear: () => void;
      mock: { calls: Array<[unknown, RequestInit | undefined]> };
    };
    fetchMock.mockClear();

    const [firstNodeButton] = await screen.findAllByTestId(/node-select-/);
    fireEvent.click(firstNodeButton);
    await new Promise((resolve) => setTimeout(resolve, 950));

    const patchCalls = fetchMock.mock.calls.filter(([url, init]) =>
      String(url).includes(`/api/workflow-canvases/${canvas.id}`) && init?.method === 'PATCH'
    );

    expect(patchCalls).toHaveLength(0);
  });

  it('persists title-only changes', async () => {
    await renderLoadedPage();

    const fetchMock = global.fetch as unknown as {
      mockClear: () => void;
      mock: { calls: Array<[unknown, RequestInit | undefined]> };
    };
    fetchMock.mockClear();

    const titleInput = screen.getByDisplayValue('Workflow canvas');
    fireEvent.change(titleInput, {
      target: { value: 'Updated workflow canvas' },
    });
    fireEvent.blur(titleInput);

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(([url, init]) =>
        String(url).includes(`/api/workflow-canvases/${canvas.id}`) && init?.method === 'PATCH'
      );
      expect(patchCalls).toHaveLength(1);
    });

    const patchCalls = fetchMock.mock.calls.filter(([url, init]) =>
      String(url).includes(`/api/workflow-canvases/${canvas.id}`) && init?.method === 'PATCH'
    );
    expect(patchCalls).toHaveLength(1);
    const payload = JSON.parse(String(patchCalls[0]?.[1]?.body || '{}'));
    expect(payload.title).toBe('Updated workflow canvas');
  });

});
