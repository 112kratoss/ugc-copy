import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateWorkflowPage from '@/app/create-workflow/page';
import CreateWorkflowEntry from '@/app/create-workflow/CreateWorkflowEntry';
import { buildGenerationModelCatalog } from '@/lib/generation-model-catalog';
import { createStarterGraph, type WorkflowCanvasRecord } from '@/lib/workflow-canvas';

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockRefreshSessionState = vi.fn(async () => undefined);
const mockUpdateCredits = vi.fn();
let mockSession = {
  access_token: 'test-token',
  user: { id: 'user-1' },
};
const mockRouter = {
  push: mockPush,
  replace: mockReplace,
};
const DEFAULT_IMPORTED_SHARE_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: mockSession,
    user: mockSession.user,
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
    getNode: vi.fn((id: string) => (latestPropsRef.current?.nodes ?? []).find((node: { id: string }) => node.id === id)),
    fitView: vi.fn(async () => undefined),
    setViewport: vi.fn(async () => undefined),
  };

  function ReactFlow(props: Record<string, unknown>) {
    const nodes = (props.nodes as Array<{
      id: string;
      data: {
        title: string;
        __runtime?: {
          isRunMenuOpen?: boolean;
          onDeleteNode?: () => void;
          onOpenRunMenu?: () => void;
          onRunBranch?: () => void;
          onRunNode?: () => void;
          showPlayControl?: boolean;
        };
      };
    }>) || [];
    const edges = (props.edges as Array<{ id: string; data?: { onDeleteEdge?: (edgeId: string) => void } }>) || [];
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
          onClick={() => (props.onPaneClick as (() => void) | undefined)?.()}
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
          <div
            key={node.id}
            className="react-flow__node"
            data-id={node.id}
            data-testid={`flow-node-${node.id}`}
          >
            <button
              type="button"
              data-testid={`node-click-${node.id}`}
              onClick={() => {
                (props.onSelectionChange as ((selection: { nodes: Array<{ id: string }>; edges: Array<{ id: string }> }) => void) | undefined)?.({
                  nodes: [{ id: node.id }],
                  edges: [],
                });
                (props.onNodeClick as ((event: Record<string, unknown>, node: { id: string; data: { title: string } }) => void) | undefined)?.({
                  preventDefault() {},
                  stopPropagation() {},
                  shiftKey: false,
                  metaKey: false,
                  ctrlKey: false,
                }, node);
              }}
            >
              Click {node.data.title}
            </button>
            <button
              type="button"
              data-testid={`node-doubleclick-${node.id}`}
              onClick={() => {
                (props.onSelectionChange as ((selection: { nodes: Array<{ id: string }>; edges: Array<{ id: string }> }) => void) | undefined)?.({
                  nodes: [{ id: node.id }],
                  edges: [],
                });
                (props.onNodeDoubleClick as ((event: Record<string, unknown>, node: { id: string; data: { title: string } }) => void) | undefined)?.({
                  preventDefault() {},
                  stopPropagation() {},
                  shiftKey: false,
                  metaKey: false,
                  ctrlKey: false,
                }, node);
              }}
            >
              Double click {node.data.title}
            </button>
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
              data-testid={`node-drag-start-${node.id}`}
              onClick={() => {
                (props.onSelectionChange as ((selection: { nodes: Array<{ id: string }>; edges: Array<{ id: string }> }) => void) | undefined)?.({
                  nodes: [{ id: node.id }],
                  edges: [],
                });
                (props.onNodeDragStart as ((event: Record<string, unknown>, node: { id: string }, nodes: Array<{ id: string }>) => void) | undefined)?.({
                  preventDefault() {},
                  stopPropagation() {},
                }, node, [node]);
              }}
            >
              Drag start {node.data.title}
            </button>
            <button
              type="button"
              data-testid={`node-drag-stop-${node.id}`}
              onClick={() => {
                (props.onSelectionChange as ((selection: { nodes: Array<{ id: string }>; edges: Array<{ id: string }> }) => void) | undefined)?.({
                  nodes: [{ id: node.id }],
                  edges: [],
                });
                (props.onNodeDragStop as ((event: Record<string, unknown>, node: { id: string }, nodes: Array<{ id: string }>) => void) | undefined)?.({
                  preventDefault() {},
                  stopPropagation() {},
                }, node, [node]);
              }}
            >
              Drag stop {node.data.title}
            </button>
            <button
              type="button"
              data-testid={`node-drag-move-${node.id}`}
              onClick={() =>
                (props.onNodesChange as ((changes: Array<Record<string, unknown>>) => void) | undefined)?.([
                  {
                    id: node.id,
                    type: 'position',
                    position: { x: 360, y: 260 },
                    dragging: true,
                  },
                ])
              }
            >
              Drag move {node.data.title}
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
            {typeof node.data.__runtime?.onDeleteNode === 'function' && (
              <button
                type="button"
                data-testid={`node-delete-${node.id}`}
                onClick={() => node.data.__runtime?.onDeleteNode?.()}
              >
                Delete node {node.data.title}
              </button>
            )}
            {node.data.__runtime?.showPlayControl && (
              <button
                type="button"
                data-testid={`node-run-menu-${node.id}`}
                onClick={() => node.data.__runtime?.onOpenRunMenu?.()}
              >
                Open run menu {node.data.title}
              </button>
            )}
            {node.data.__runtime?.isRunMenuOpen && typeof node.data.__runtime?.onRunNode === 'function' && (
              <button
                type="button"
                data-testid={`node-run-step-${node.id}`}
                onClick={() => node.data.__runtime?.onRunNode?.()}
              >
                Run step {node.data.title}
              </button>
            )}
            {node.data.__runtime?.isRunMenuOpen && typeof node.data.__runtime?.onRunBranch === 'function' && (
              <button
                type="button"
                data-testid={`node-run-branch-${node.id}`}
                onClick={() => node.data.__runtime?.onRunBranch?.()}
              >
                Run branch {node.data.title}
              </button>
            )}
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
            {typeof edge.data?.onDeleteEdge === 'function' && (
              <button
                type="button"
                data-testid={`edge-delete-${edge.id}`}
                onClick={() => edge.data?.onDeleteEdge?.(edge.id)}
              >
                Delete edge {edge.id}
              </button>
            )}
          </div>
        ))}
      </div>
    );
  }

  return {
    addEdge: (edge: Record<string, unknown>, current: Array<Record<string, unknown>>) => [...current, edge],
    applyEdgeChanges: (_changes: Array<Record<string, unknown>>, current: Array<Record<string, unknown>>) => current,
    applyNodeChanges: (changes: Array<Record<string, unknown>>, current: Array<Record<string, unknown>>) =>
      changes.reduce<Array<Record<string, unknown>>>((nodes, change): Array<Record<string, unknown>> => {
        if (change.type === 'position') {
          return nodes.map((node) => (
            node.id === change.id
              ? { ...node, position: change.position ?? node.position }
              : node
          ));
        }

        if (change.type === 'select') {
          return nodes.map((node) => (
            node.id === change.id
              ? { ...node, selected: change.selected }
              : node
          ));
        }

        if (change.type === 'remove') {
          return nodes.filter((node) => node.id !== change.id);
        }

        if (change.type === 'add' && change.item) {
          return [...nodes, change.item as Record<string, unknown>];
        }

        if (change.type === 'replace' && change.item) {
          return nodes.map((node) => (
            node.id === change.id
              ? change.item as Record<string, unknown>
              : node
          ));
        }

        return nodes;
      }, current),
    Background: () => <div data-testid="rf-background" />,
    BackgroundVariant: { Dots: 'dots' },
    BaseEdge: () => <div data-testid="rf-base-edge" />,
    Controls: () => <div data-testid="rf-controls" />,
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Handle: () => null,
    MiniMap: () => <div data-testid="rf-minimap" />,
    Position: { Left: 'left', Right: 'right' },
    ReactFlow,
    SelectionMode: { Partial: 'partial', Full: 'full' },
    getBezierPath: () => ['M0 0', 120, 80],
  };
});

describe('CreateWorkflowPage', () => {
  let canvasesById: Record<string, WorkflowCanvasRecord>;
  let sharesById: Record<string, {
    id: string;
    title: string;
    nodeCount: number;
    edgeCount: number;
    importCount: number;
    createdAt: string;
    importPath: string;
    importUrl: string;
    graph: WorkflowCanvasRecord['graph'];
  }>;
  let lastRunRequest: { canvasId: string; mode: string; startNodeId: string; catalogRevision?: string | null } | null;
  let orderedCanvasIds: string[];
  let nextCanvasIdNumber: number;
  let nextShareIdNumber: number;
  const workflowCatalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 1 });

  function buildShareId(value: number) {
    return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
  }

  async function renderLoadedPage(options?: { initialImportShareId?: string | null }) {
    render(<CreateWorkflowPage initialImportShareId={options?.initialImportShareId ?? null} />);
    await screen.findByDisplayValue('Workflow canvas');
    await screen.findByTestId(`node-select-${canvasesById['canvas-1']?.graph.nodes[0]?.id}`);
  }

  function getWorkflowTitleInput() {
    return screen.getByRole('textbox', { name: /workflow title/i });
  }

  function getWorkflowButton(title: string) {
    return screen.getByRole('button', { name: `Open workflow ${title}` });
  }

  function queryWorkflowButton(title: string) {
    return screen.queryByRole('button', { name: `Open workflow ${title}` });
  }

  function getWorkflowActionsButton(title: string) {
    return screen.getByRole('button', { name: `Open actions for ${title}` });
  }

  beforeEach(() => {
    mockPush.mockReset();
    mockReplace.mockReset();
    mockSession = {
      access_token: 'test-token',
      user: { id: 'user-1' },
    };
    lastRunRequest = null;
    const secondGraph = createStarterGraph();
    secondGraph.nodes = secondGraph.nodes.map((node, index) => (
      index === 0
        ? { ...node, data: { ...node.data, title: 'Second workflow prompt' } }
        : node
    ));

    canvasesById = {
      'canvas-1': {
        id: 'canvas-1',
        title: 'Workflow canvas',
        graph: createStarterGraph(),
        created_at: '2026-03-22T00:00:00.000Z',
        updated_at: '2026-03-22T00:00:00.000Z',
        revision: 0,
        status: 'draft',
        published_at: null,
      },
      'canvas-2': {
        id: 'canvas-2',
        title: 'Second workflow',
        graph: secondGraph,
        created_at: '2026-03-22T00:10:00.000Z',
        updated_at: '2026-03-22T00:10:00.000Z',
        revision: 0,
        status: 'draft',
        published_at: null,
      },
    };
    orderedCanvasIds = ['canvas-1', 'canvas-2'];
    nextCanvasIdNumber = 3;
    nextShareIdNumber = 1;
    sharesById = {
      [DEFAULT_IMPORTED_SHARE_ID]: {
        id: DEFAULT_IMPORTED_SHARE_ID,
        title: 'Shared workflow',
        nodeCount: canvasesById['canvas-2'].graph.nodes.length,
        edgeCount: canvasesById['canvas-2'].graph.edges.length,
        importCount: 0,
        createdAt: '2026-04-02T10:00:00.000Z',
        importPath: `/create-workflow?import=${DEFAULT_IMPORTED_SHARE_ID}`,
        importUrl: `http://localhost/create-workflow?import=${DEFAULT_IMPORTED_SHARE_ID}`,
        graph: canvasesById['canvas-2'].graph,
      },
    };
    delete (window as Window & { __ugcWorkflowListCollapsed?: boolean }).__ugcWorkflowListCollapsed;

    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.includes('/api/generation-models') && method === 'GET') {
        return {
          ok: true,
          json: async () => workflowCatalog,
        } as Response;
      }

      if (url.endsWith('/api/workflow-canvases') && method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            canvases: orderedCanvasIds.map((id) => {
              const canvas = canvasesById[id];
              return {
                id: canvas.id,
                title: canvas.title,
                updated_at: canvas.updated_at,
                revision: canvas.revision,
                status: canvas.status,
                published_at: canvas.published_at,
              };
            }),
          }),
        } as Response;
      }

      const canvasMatch = url.match(/\/api\/workflow-canvases\/([^/]+)$/);
      if (canvasMatch && method === 'GET') {
        const canvas = canvasesById[canvasMatch[1]];
        return {
          ok: true,
          json: async () => ({ canvas }),
        } as Response;
      }

      const shareCanvasMatch = url.match(/\/api\/workflow-canvases\/([^/]+)\/share$/);
      if (shareCanvasMatch && method === 'POST') {
        const canvas = canvasesById[shareCanvasMatch[1]];
        const shareId = buildShareId(nextShareIdNumber);
        nextShareIdNumber += 1;
        sharesById[shareId] = {
          id: shareId,
          title: canvas.title,
          nodeCount: canvas.graph.nodes.length,
          edgeCount: canvas.graph.edges.length,
          importCount: 0,
          createdAt: '2026-04-02T10:10:00.000Z',
          importPath: `/create-workflow?import=${shareId}`,
          importUrl: `http://localhost/create-workflow?import=${shareId}`,
          graph: canvas.graph,
        };

        return {
          ok: true,
          json: async () => ({
            share: {
              id: shareId,
              title: canvas.title,
              nodeCount: canvas.graph.nodes.length,
              edgeCount: canvas.graph.edges.length,
              importCount: 0,
              createdAt: '2026-04-02T10:10:00.000Z',
              importPath: `/create-workflow?import=${shareId}`,
              importUrl: `http://localhost/create-workflow?import=${shareId}`,
            },
          }),
        } as Response;
      }

      if (canvasMatch && method === 'PATCH') {
        const canvasId = canvasMatch[1];
        const payload = JSON.parse(String(init?.body || '{}'));
        const current = canvasesById[canvasId];
        canvasesById[canvasId] = {
          ...current,
          title: payload.title ?? current.title,
          graph: payload.graph ?? current.graph,
          revision: current.revision + 1,
          updated_at: '2026-03-22T00:12:00.000Z',
        };

        return {
          ok: true,
          json: async () => ({ canvas: canvasesById[canvasId] }),
        } as Response;
      }

      const sharePreviewMatch = url.match(/\/api\/workflow-shares\/([^/]+)$/);
      if (sharePreviewMatch && method === 'GET') {
        const share = sharesById[sharePreviewMatch[1]];
        if (!share) {
          return {
            ok: false,
            status: 404,
            json: async () => ({ error: 'Workflow share not found.' }),
          } as Response;
        }

        return {
          ok: true,
          json: async () => ({
            share,
          }),
        } as Response;
      }

      const shareImportMatch = url.match(/\/api\/workflow-shares\/([^/]+)\/import$/);
      if (shareImportMatch && method === 'POST') {
        const share = sharesById[shareImportMatch[1]];
        if (!share) {
          return {
            ok: false,
            status: 404,
            json: async () => ({ error: 'Workflow share not found.' }),
          } as Response;
        }

        const createdCanvasNumber = nextCanvasIdNumber;
        nextCanvasIdNumber += 1;
        const timestampMinute = String(20 + createdCanvasNumber).padStart(2, '0');
        const createdCanvas: WorkflowCanvasRecord = {
          id: `canvas-${createdCanvasNumber}`,
          title: `Copy of ${share.title}`,
          graph: share.graph,
          created_at: `2026-03-22T00:${timestampMinute}:00.000Z`,
          updated_at: `2026-03-22T00:${timestampMinute}:00.000Z`,
          revision: 0,
          status: 'draft',
          published_at: null,
        };

        canvasesById[createdCanvas.id] = createdCanvas;
        orderedCanvasIds = [createdCanvas.id, ...orderedCanvasIds];

        return {
          ok: true,
          json: async () => ({
            canvas: createdCanvas,
            share: {
              id: share.id,
              title: share.title,
              nodeCount: share.nodeCount,
              edgeCount: share.edgeCount,
              importCount: share.importCount + 1,
              createdAt: share.createdAt,
              importPath: share.importPath,
              importUrl: share.importUrl,
            },
          }),
        } as Response;
      }

      const runMatch = url.match(/\/api\/workflow-canvases\/([^/]+)\/run$/);
      if (runMatch && method === 'POST') {
        const payload = JSON.parse(String(init?.body || '{}'));
        lastRunRequest = {
          canvasId: runMatch[1],
          mode: payload.mode,
          startNodeId: payload.startNodeId,
          catalogRevision: payload.catalogRevision,
        };

        return {
          ok: true,
          json: async () => ({
            runId: 'run-1',
            status: 'processing',
          }),
        } as Response;
      }

      const runDetailsMatch = url.match(/\/api\/workflow-canvases\/([^/]+)\/runs\/([^/]+)$/);
      if (runDetailsMatch && method === 'GET') {
        const canvas = canvasesById[runDetailsMatch[1]];
        const startNodeId = lastRunRequest?.startNodeId ?? canvas.graph.nodes[0]?.id;
        const targetNode = canvas.graph.nodes.find((node) => node.id === startNodeId);

        return {
          ok: true,
          json: async () => ({
            run: {
              id: runDetailsMatch[2],
              canvas_id: runDetailsMatch[1],
              start_node_id: startNodeId,
              mode: lastRunRequest?.mode ?? 'branch',
              status: 'succeeded',
              created_at: '2026-03-22T00:13:00.000Z',
              finished_at: '2026-03-22T00:13:10.000Z',
              steps: targetNode ? [{
                id: 'step-1',
                node_id: targetNode.id,
                status: 'succeeded',
                generation_id: 'gen-1',
                input_snapshot: null,
                output_snapshot: {
                  outputUrl: 'generated_images/user-1/run-1.jpg',
                  cost: 4,
                },
                error_message: null,
                started_at: '2026-03-22T00:13:01.000Z',
                finished_at: '2026-03-22T00:13:09.000Z',
              }] : [],
            },
          }),
        } as Response;
      }

      if (url.endsWith('/api/workflow-canvases') && method === 'POST') {
        const payload = JSON.parse(String(init?.body || '{}'));
        const createdCanvasNumber = nextCanvasIdNumber;
        nextCanvasIdNumber += 1;
        const timestampMinute = String(20 + createdCanvasNumber).padStart(2, '0');
        const createdCanvas: WorkflowCanvasRecord = {
          id: `canvas-${createdCanvasNumber}`,
          title: typeof payload.title === 'string' ? payload.title : `Workflow ${createdCanvasNumber}`,
          graph: payload.graph ?? createStarterGraph(),
          created_at: `2026-03-22T00:${timestampMinute}:00.000Z`,
          updated_at: `2026-03-22T00:${timestampMinute}:00.000Z`,
          revision: 0,
          status: 'draft',
          published_at: null,
        };
        canvasesById[createdCanvas.id] = createdCanvas;
        orderedCanvasIds = [createdCanvas.id, ...orderedCanvasIds];
        return {
          ok: true,
          json: async () => ({ canvas: createdCanvas }),
        } as Response;
      }

      if (canvasMatch && method === 'DELETE') {
        delete canvasesById[canvasMatch[1]];
        orderedCanvasIds = orderedCanvasIds.filter((id) => id !== canvasMatch[1]);
        return {
          ok: true,
          json: async () => ({ success: true }),
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

  it('renders the simplified left rail and removes lifecycle-heavy controls', async () => {
    await renderLoadedPage();

    const leftRail = screen.getByTestId('workflow-left-rail');
    const mobileLibraryTrigger = screen.getByRole('button', { name: /open nodes and workflows/i });

    expect(leftRail).toBeInTheDocument();
    expect(leftRail).toHaveClass('hidden', 'md:flex');
    expect(mobileLibraryTrigger).toHaveClass('md:hidden', 'min-h-11');
    expect(mobileLibraryTrigger).toHaveAttribute('aria-controls', 'workflow-left-rail');
    expect(screen.getByText(/build your graph/i)).toBeInTheDocument();
    expect(screen.getByText(/^workflows$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new workflow/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();

    expect(screen.getByRole('button', { name: /ai builder/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /history/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /publish as template/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /command/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create draft/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sync now/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^share workflow$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^import workflow$/i })).toBeInTheDocument();
  });

  it('opens a canvas deep link in the organized editor and returns to the library', async () => {
    render(<CreateWorkflowEntry initialCanvasId="canvas-2" />);

    expect(await screen.findByDisplayValue('Second workflow')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open node library/i })).toBeInTheDocument();
    expect(screen.queryByText(/^workflows$/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /^all workflows$/i })[0]);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/create-workflow');
    });
  });

  it('opens an accessible mobile node and workflow drawer that stays below the publish sheet', async () => {
    await renderLoadedPage();

    fireEvent.click(screen.getByRole('button', { name: /open nodes and workflows/i }));

    const mobileDrawer = screen.getByRole('dialog', { name: /build your graph/i });
    expect(mobileDrawer).toBe(screen.getByTestId('workflow-left-rail'));
    expect(mobileDrawer).toHaveAttribute('aria-modal', 'true');
    expect(mobileDrawer).toHaveClass('fixed', 'z-[70]', 'md:static', 'md:z-auto');
    expect(screen.getByRole('button', { name: /dismiss nodes and workflows/i })).toHaveClass('z-[60]');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /build your graph/i })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /open nodes and workflows/i })).toBeInTheDocument();
  }, 10_000);

  it('adds a node from the mobile drawer and returns directly to the canvas', async () => {
    await renderLoadedPage();
    const initialNodeCount = screen.getAllByTestId(/node-select-/).length;

    fireEvent.click(screen.getByRole('button', { name: /open nodes and workflows/i }));
    const mobileDrawer = screen.getByRole('dialog', { name: /build your graph/i });
    fireEvent.click(within(mobileDrawer).getByRole('button', { name: /^prompt$/i }));

    await waitFor(() => {
      expect(screen.getAllByTestId(/node-select-/)).toHaveLength(initialNodeCount + 1);
    });
    expect(screen.queryByRole('dialog', { name: /build your graph/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open nodes and workflows/i })).toBeInTheDocument();
  });

  it('collapses the workflow list while keeping new workflow available', async () => {
    await renderLoadedPage();

    const leftRail = within(screen.getByTestId('workflow-left-rail'));
    expect(leftRail.getByTestId('workflow-canvas-list')).toBeInTheDocument();
    expect(leftRail.getByRole('button', { name: 'Open workflow Second workflow' })).toBeInTheDocument();

    fireEvent.click(leftRail.getByRole('button', { name: /collapse workflows/i }));

    expect(leftRail.queryByTestId('workflow-canvas-list')).not.toBeInTheDocument();
    expect(leftRail.queryByRole('button', { name: 'Open workflow Second workflow' })).not.toBeInTheDocument();
    expect(leftRail.getByRole('button', { name: /expand workflows/i })).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(leftRail.getByRole('button', { name: /new workflow/i }));

    await waitFor(() => {
      expect(getWorkflowTitleInput()).toHaveValue('Workflow 3');
    });

    expect(leftRail.queryByTestId('workflow-canvas-list')).not.toBeInTheDocument();

    fireEvent.click(leftRail.getByRole('button', { name: /expand workflows/i }));

    expect(await leftRail.findByRole('button', { name: 'Open workflow Second workflow' })).toBeInTheDocument();
  });

  it('opens workflow actions without switching the active workflow and allows canceling delete', async () => {
    await renderLoadedPage();

    fireEvent.click(getWorkflowActionsButton('Second workflow'));

    expect(getWorkflowTitleInput()).toHaveValue('Workflow canvas');
    expect(screen.queryByText(/save before continuing/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: /^delete workflow$/i }));

    const dialog = await screen.findByTestId('workflow-delete-dialog');
    expect(dialog).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => {
      expect(screen.queryByTestId('workflow-delete-dialog')).not.toBeInTheDocument();
    });

    expect(getWorkflowButton('Second workflow')).toBeInTheDocument();
    expect(getWorkflowTitleInput()).toHaveValue('Workflow canvas');
  });

  it('deletes an inactive workflow from the left rail actions menu', async () => {
    await renderLoadedPage();

    fireEvent.click(getWorkflowActionsButton('Second workflow'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^delete workflow$/i }));
    fireEvent.click(within(screen.getByTestId('workflow-delete-dialog')).getByRole('button', { name: /^delete workflow$/i }));

    await waitFor(() => {
      expect(queryWorkflowButton('Second workflow')).not.toBeInTheDocument();
    });

    expect(orderedCanvasIds).toEqual(['canvas-1']);
    expect(getWorkflowTitleInput()).toHaveValue('Workflow canvas');
  });

  it('shows a delete-specific warning when deleting the active workflow with unsaved changes', async () => {
    await renderLoadedPage();

    fireEvent.change(getWorkflowTitleInput(), {
      target: { value: 'Unsaved title' },
    });

    fireEvent.click(getWorkflowActionsButton('Unsaved title'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^delete workflow$/i }));

    const dialog = await screen.findByTestId('workflow-delete-dialog');
    expect(within(dialog).getByText(/any unsaved changes in it will be lost/i)).toBeInTheDocument();
    expect(screen.queryByText(/save before continuing/i)).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: /^delete workflow$/i }));

    await waitFor(() => {
      expect(getWorkflowTitleInput()).toHaveValue('Second workflow');
    });

    expect(queryWorkflowButton('Unsaved title')).not.toBeInTheDocument();
    expect(screen.queryByText(/save before continuing/i)).not.toBeInTheDocument();
  });

  it('creates a replacement workflow when deleting the last remaining canvas', async () => {
    canvasesById = {
      'canvas-1': canvasesById['canvas-1'],
    };
    orderedCanvasIds = ['canvas-1'];

    await renderLoadedPage();

    fireEvent.click(getWorkflowActionsButton('Workflow canvas'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^delete workflow$/i }));
    fireEvent.click(within(screen.getByTestId('workflow-delete-dialog')).getByRole('button', { name: /^delete workflow$/i }));

    await waitFor(() => {
      expect(getWorkflowTitleInput()).toHaveValue('Workflow 2');
    });

    expect(orderedCanvasIds).toHaveLength(1);
    expect(orderedCanvasIds[0]).not.toBe('canvas-1');
    expect(getWorkflowButton('Workflow 2')).toBeInTheDocument();
  });

  it('saves a dirty workflow before creating a share link snapshot', async () => {
    await renderLoadedPage();
    const fetchMock = global.fetch as unknown as {
      mockClear: () => void;
      mock: { calls: Array<[unknown, RequestInit | undefined]> };
    };

    fireEvent.change(screen.getByLabelText(/workflow title/i), {
      target: { value: 'Workflow canvas updated' },
    });

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^share workflow$/i }));

    const dialog = await screen.findByTestId('workflow-share-dialog');
    expect(await within(dialog).findByDisplayValue(/http:\/\/localhost\/create-workflow\?import=/i)).toBeInTheDocument();

    const patchIndex = fetchMock.mock.calls.findIndex(([url, init]) =>
      String(url).includes('/api/workflow-canvases/canvas-1') && init?.method === 'PATCH'
    );
    const shareIndex = fetchMock.mock.calls.findIndex(([url, init]) =>
      String(url).includes('/api/workflow-canvases/canvas-1/share') && init?.method === 'POST'
    );

    expect(patchIndex).toBeGreaterThan(-1);
    expect(shareIndex).toBeGreaterThan(patchIndex);
    expect(within(dialog).getByText(/uploaded media, storage paths, run outputs/i)).toBeInTheDocument();
  });

  it('previews and imports a shared workflow from a pasted link', async () => {
    await renderLoadedPage();

    fireEvent.click(screen.getByRole('button', { name: /^import workflow$/i }));

    const dialog = await screen.findByTestId('workflow-import-dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /shared workflow url or id/i }), {
      target: { value: `http://localhost/create-workflow?import=${DEFAULT_IMPORTED_SHARE_ID}` },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /^preview import$/i }));

    expect(await within(dialog).findByText('Shared workflow')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /^import workflow$/i }));

    await waitFor(() => {
      expect(getWorkflowTitleInput()).toHaveValue('Copy of Shared workflow');
    });

    expect(orderedCanvasIds[0]).not.toBe('canvas-1');
    expect(getWorkflowButton('Copy of Shared workflow')).toBeInTheDocument();
  });

  it('shows actionable errors for missing or invalid workflow share links', async () => {
    await renderLoadedPage();

    fireEvent.click(screen.getByRole('button', { name: /^import workflow$/i }));

    const dialog = await screen.findByTestId('workflow-import-dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /shared workflow url or id/i }), {
      target: { value: 'not-a-share-id' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /^preview import$/i }));

    expect(await within(dialog).findByText(/paste a shared workflow link or share id/i)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByRole('textbox', { name: /shared workflow url or id/i }), {
      target: { value: '22222222-2222-4222-8222-222222222222' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /^preview import$/i }));

    expect(await within(dialog).findByText(/workflow share not found/i)).toBeInTheDocument();
  });

  it('opens the import preview automatically from a shared workflow deep link and clears the url after import', async () => {
    await renderLoadedPage({ initialImportShareId: DEFAULT_IMPORTED_SHARE_ID });

    const dialog = await screen.findByTestId('workflow-import-dialog');
    expect(await within(dialog).findByText('Shared workflow')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: /^import workflow$/i }));

    await waitFor(() => {
      expect(getWorkflowTitleInput()).toHaveValue('Copy of Shared workflow');
    });

    expect(mockReplace).toHaveBeenCalledWith('/create-workflow');
  });

  it('keeps selection-first editing and opens the node-anchored popup from right click, Enter, and double click', async () => {
    await renderLoadedPage();

    const firstNodeId = canvasesById['canvas-1'].graph.nodes[0]?.id;
    expect(firstNodeId).toBeTruthy();

    fireEvent.click(await screen.findByTestId(`node-click-${firstNodeId}`));
    expect(screen.queryByTestId('workflow-inspector-popup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workflow-inspector-menu')).not.toBeInTheDocument();

    fireEvent.click(await screen.findByTestId(`node-context-${firstNodeId}`));
    fireEvent.click(await screen.findByRole('button', { name: /edit node/i }));
    expect(await screen.findByTestId('dock-node-editor')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-inspector-caret')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pane-click'));
    await waitFor(() => {
      expect(screen.queryByTestId('workflow-inspector-popup')).not.toBeInTheDocument();
    });

    fireEvent.click(await screen.findByTestId(`node-select-${firstNodeId}`));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(await screen.findByTestId('dock-node-editor')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pane-click'));
    fireEvent.click(await screen.findByTestId(`node-doubleclick-${firstNodeId}`));
    expect(await screen.findByTestId('dock-node-editor')).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId(`node-select-${firstNodeId}`));
    expect(await screen.findByTestId('dock-node-editor')).toBeInTheDocument();
  });

  it('keeps the popup closed while dragging', async () => {
    await renderLoadedPage();

    const firstNodeId = canvasesById['canvas-1'].graph.nodes[0]?.id;
    expect(firstNodeId).toBeTruthy();

    fireEvent.click(await screen.findByTestId(`node-doubleclick-${firstNodeId}`));
    expect(await screen.findByTestId('dock-node-editor')).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId(`node-drag-start-${firstNodeId}`));
    await waitFor(() => {
      expect(screen.queryByTestId('dock-node-editor')).not.toBeInTheDocument();
    });

    fireEvent.click(await screen.findByTestId(`node-drag-stop-${firstNodeId}`));
    expect(screen.queryByTestId('dock-node-editor')).not.toBeInTheDocument();
  });

  it('deletes a connection directly from the edge control callback', async () => {
    await renderLoadedPage();

    const firstEdgeId = canvasesById['canvas-1'].graph.edges[0]?.id;
    expect(firstEdgeId).toBeTruthy();
    expect(await screen.findByTestId(`edge-delete-${firstEdgeId}`)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`edge-delete-${firstEdgeId}`));

    await waitFor(() => {
      expect(screen.queryByTestId(`edge-delete-${firstEdgeId}`)).not.toBeInTheDocument();
    });

    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
  });

  it('saves before running a node branch from the hover control', async () => {
    await renderLoadedPage();
    const fetchMock = global.fetch as unknown as {
      mock: { calls: Array<[unknown, RequestInit | undefined]> };
    };

    const promptNodeId = canvasesById['canvas-1'].graph.nodes[0]?.id;
    expect(promptNodeId).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/workflow title/i), {
      target: { value: 'Workflow canvas updated' },
    });

    fireEvent.click(await screen.findByTestId(`node-run-menu-${promptNodeId}`));
    fireEvent.click(await screen.findByTestId(`node-run-branch-${promptNodeId}`));

    await waitFor(() => {
      expect(lastRunRequest).toEqual({
        canvasId: 'canvas-1',
        mode: 'branch',
        startNodeId: promptNodeId,
        catalogRevision: workflowCatalog.revision,
      });
    });

    const patchIndex = fetchMock.mock.calls.findIndex(([url, init]) =>
      String(url).includes('/api/workflow-canvases/canvas-1') && init?.method === 'PATCH'
    );
    const runIndex = fetchMock.mock.calls.findIndex(([url, init]) =>
      String(url).includes('/api/workflow-canvases/canvas-1/run') && init?.method === 'POST'
    );

    expect(patchIndex).toBeGreaterThan(-1);
    expect(runIndex).toBeGreaterThan(patchIndex);
    expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument();
  });

  it('deletes a node directly from the hover control', async () => {
    await renderLoadedPage();

    const noteNodeId = canvasesById['canvas-1'].graph.nodes.find((node) => node.type === 'note')?.id;
    expect(noteNodeId).toBeTruthy();
    expect(await screen.findByTestId(`node-delete-${noteNodeId}`)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`node-delete-${noteNodeId}`));

    await waitFor(() => {
      expect(screen.queryByTestId(`node-delete-${noteNodeId}`)).not.toBeInTheDocument();
    });

    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
  });

  it('uses manual save instead of autosave for title changes', async () => {
    await renderLoadedPage();

    const fetchMock = global.fetch as unknown as {
      mockClear: () => void;
      mock: { calls: Array<[unknown, RequestInit | undefined]> };
    };
    fetchMock.mockClear();

    fireEvent.change(screen.getByLabelText(/workflow title/i), {
      target: { value: 'Updated workflow canvas' },
    });

    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();

    await new Promise((resolve) => setTimeout(resolve, 950));

    let patchCalls = fetchMock.mock.calls.filter(([url, init]) =>
      String(url).includes('/api/workflow-canvases/canvas-1') && init?.method === 'PATCH'
    );
    expect(patchCalls).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      patchCalls = fetchMock.mock.calls.filter(([url, init]) =>
        String(url).includes('/api/workflow-canvases/canvas-1') && init?.method === 'PATCH'
      );
      expect(patchCalls).toHaveLength(1);
    });

    const payload = JSON.parse(String(patchCalls[0]?.[1]?.body || '{}'));
    expect(payload.title).toBe('Updated workflow canvas');
  });

  it('shows save discard cancel when switching workflows with unsaved changes', async () => {
    await renderLoadedPage();

    fireEvent.change(screen.getByLabelText(/workflow title/i), {
      target: { value: 'Unsaved title' },
    });

    fireEvent.click(getWorkflowButton('Second workflow'));
    expect(await screen.findByText(/save before continuing/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => {
      expect(screen.queryByText(/save before continuing/i)).not.toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('Unsaved title')).toBeInTheDocument();

    fireEvent.click(getWorkflowButton('Second workflow'));
    fireEvent.click(await screen.findByRole('button', { name: /^discard$/i }));

    await waitFor(() => {
      expect(screen.getByDisplayValue('Second workflow')).toBeInTheDocument();
    });
  });

  it('drops the previous template context when switching workflows', async () => {
    const fetchMock = vi.mocked(fetch);
    const baseFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/templates' && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body || '{}')) as { name: string; sourceCanvasId: string };
        return new Response(JSON.stringify({
          template: {
            id: `template-for-${payload.sourceCanvasId}`,
            name: payload.name,
          },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.startsWith('/api/templates/') && init?.method === 'PATCH') {
        throw new Error(`Stale template context patched: ${url}`);
      }
      return baseFetch(input, init);
    });

    await renderLoadedPage();
    fireEvent.click(screen.getByRole('button', { name: /publish as template/i }));
    expect(await screen.findByTestId('workflow-template-publish-drawer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save draft/i }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => (
        String(url) === '/api/templates'
        && init?.method === 'POST'
        && JSON.parse(String(init.body || '{}')).sourceCanvasId === 'canvas-1'
      ))).toBe(true);
    });

    fireEvent.click(getWorkflowButton('Second workflow'));
    await waitFor(() => expect(getWorkflowTitleInput()).toHaveValue('Second workflow'));
    expect(screen.queryByTestId('workflow-template-publish-drawer')).not.toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith('/create-workflow');

    fireEvent.click(screen.getByRole('button', { name: /publish as template/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save draft/i }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => (
        String(url) === '/api/templates'
        && init?.method === 'POST'
        && JSON.parse(String(init.body || '{}')).sourceCanvasId === 'canvas-2'
      ))).toBe(true);
    });
    expect(fetchMock.mock.calls.some(([url, init]) => (
      String(url).startsWith('/api/templates/template-for-canvas-1') && init?.method === 'PATCH'
    ))).toBe(false);
  }, 10_000);

  it('can create a new workflow from the left rail', async () => {
    await renderLoadedPage();

    fireEvent.click(screen.getByRole('button', { name: /new workflow/i }));

    await waitFor(() => {
      expect(screen.getByDisplayValue('Workflow 3')).toBeInTheDocument();
    });
  });

  it('keeps unsaved graph edits when the same user session token refreshes', async () => {
    const view = render(<CreateWorkflowPage />);
    await screen.findByDisplayValue('Workflow canvas');
    await screen.findByTestId(`node-select-${canvasesById['canvas-1']?.graph.nodes[0]?.id}`);

    const leftRail = screen.getByTestId('workflow-left-rail');
    const initialNodeCount = screen.getAllByTestId(/node-select-/).length;

    fireEvent.click(within(leftRail).getByRole('button', { name: /^prompt$/i }));

    await waitFor(() => {
      expect(screen.getAllByTestId(/node-select-/)).toHaveLength(initialNodeCount + 1);
    });
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();

    mockSession = {
      access_token: 'refreshed-token',
      user: { id: 'user-1' },
    };
    view.rerender(<CreateWorkflowPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId(/node-select-/)).toHaveLength(initialNodeCount + 1);
    });
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Workflow canvas')).toBeInTheDocument();
  });
});
