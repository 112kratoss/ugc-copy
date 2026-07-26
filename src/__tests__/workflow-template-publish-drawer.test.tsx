import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkflowTemplatePublishDrawer } from '@/app/create-workflow/WorkflowTemplatePublishDrawer';
import {
  createTemplateReadyStarterGraph,
  createWorkflowGraphHash,
  validateWorkflowTemplateAuthoringGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';

const authState = vi.hoisted(() => ({ credits: 200 as number | null }));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({ credits: authState.credits }),
}));

type DrawerProps = ComponentProps<typeof WorkflowTemplatePublishDrawer>;

const graph = createTemplateReadyStarterGraph();
const output = graph.nodes.find((node) => node.type === 'video-generate')!;

function currentPathHash(value: WorkflowCanvasGraph, outputNodeId: string) {
  const validation = validateWorkflowTemplateAuthoringGraph({ graph: value, outputNodeId });
  const nodeIds = new Set(validation.path.nodeIds);
  const edgeIds = new Set(validation.path.edgeIds);
  return createWorkflowGraphHash({
    ...value,
    nodes: value.nodes.filter((node) => nodeIds.has(node.id)),
    edges: value.edges.filter((edge) => edgeIds.has(edge.id)),
  }, { mode: 'template-compile' });
}

function validationResponse(estimatedTotalCredits = 116) {
  return {
    validation: {
      valid: true,
      issues: [],
      inputSlots: [],
      outputKind: 'video',
      estimatedTotalCredits,
      graphHash: 'server-graph-hash',
      canvasRevision: 2,
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderDrawer({
  credits = 200,
  ...overrides
}: Partial<DrawerProps> & { credits?: number | null } = {}) {
  authState.credits = credits;
  const props: DrawerProps = {
    activeCanvasId: 'canvas-1',
    activeCanvasRevision: 2,
    authHeaders: async () => ({ Authorization: 'Bearer token', 'Content-Type': 'application/json' }),
    canvasTitle: 'Ghost rider transformation',
    catalogRevision: 'catalog-1',
    graph,
    initialTestRunId: null,
    isOpen: true,
    outputNodeId: output.id,
    templateId: null,
    onClose: vi.fn(),
    onEnsureSaved: async () => 2,
    onFocusNode: vi.fn(),
    onOutputNodeChange: vi.fn(),
    onTemplateCreated: vi.fn(),
    ...overrides,
  };

  return {
    props,
    ...render(<WorkflowTemplatePublishDrawer {...props} />),
  };
}

describe('WorkflowTemplatePublishDrawer', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('explains the selected path and every requirement that keeps Publish locked', () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });

    expect(screen.getByRole('heading', { name: /turn this graph into a reusable format/i })).toBeInTheDocument();
    expect(screen.getByText(/ready to validate/i)).toBeInTheDocument();
    expect(screen.getByText(/a template publishes one image or video/i)).toBeInTheDocument();
    expect(screen.getByText(/dimmed nodes stay on your canvas/i)).toBeInTheDocument();
    expect(screen.getByText(/publish checklist/i)).toBeInTheDocument();
    expect(screen.getByText(/current saved revision validated/i)).toBeInTheDocument();
    expect(screen.getByText(/consumer test completed successfully/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/publish locked.*validate the current workflow/i);
    expect(screen.getByRole('button', { name: /validate/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /test in new tab/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^publish$/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /close template publishing/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the full test cost against the current balance and prevents a doomed test', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(validationResponse()));
    vi.stubGlobal('fetch', fetchMock);

    renderDrawer({ credits: 100 });
    fireEvent.click(screen.getByRole('button', { name: /validate/i }));

    expect(await screen.findByText('116 credits')).toBeInTheDocument();
    expect(screen.getByText(/your balance: 100 credits/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add 16 credits/i })).toHaveAttribute('href', '/pricing');
    expect(screen.getByRole('button', { name: /test in new tab/i })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates and opens the consumer test directly while preserving its return state', async () => {
    const replace = vi.fn();
    const close = vi.fn();
    const popup = {
      closed: false,
      close,
      location: { replace },
      opener: window,
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);

    const onTemplateCreated = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/templates/validate') return jsonResponse(validationResponse(20));
      if (url === '/api/templates' && init?.method === 'POST') {
        return jsonResponse({ template: { id: 'template-1', name: 'Ghost rider transformation' } }, 201);
      }
      if (url === '/api/templates/template-1/test') {
        return jsonResponse({ run: { id: 'run-1', status: 'collecting_inputs' } }, 201);
      }
      if (url === '/api/template-runs/run-1') {
        return jsonResponse({ run: { id: 'run-1', status: 'collecting_inputs' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    renderDrawer({ credits: 200, onTemplateCreated });
    fireEvent.click(screen.getByRole('button', { name: /test in new tab/i }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/template-runs/run-1'));
    expect(close).not.toHaveBeenCalled();
    expect(onTemplateCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'template-1' }));
    expect(await screen.findByText(/waiting for consumer uploads/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /continue consumer test/i })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('button', { name: /continue test/i })).toBeEnabled();
    await waitFor(() => {
      expect(window.localStorage.getItem(`magicbooklet:template-test:canvas-1:${output.id}`)).toContain('run-1');
    });
  });

  it('clears an expired persisted test and offers a fresh test instead of polling the missing run', async () => {
    const storageKey = `magicbooklet:template-test:canvas-1:${output.id}`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      run: { id: 'run-missing', status: 'collecting_inputs' },
      context: {
        canvasRevision: 2,
        clientPathHash: currentPathHash(graph, output.id),
        graphHash: 'server-graph-hash',
        templateId: 'template-1',
      },
    }));
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/template-runs/run-missing') {
        return jsonResponse({ error: 'Template run not found.' }, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDrawer();

    expect(await screen.findByText(/previous consumer test expired or was removed/i)).toBeInTheDocument();
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(screen.queryByText(/latest consumer test/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /test in new tab/i })).toBeEnabled();
    await waitFor(() => expect(clearIntervalSpy).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a branded recovery tab open when test setup fails', async () => {
    const popupDocument = document.implementation.createHTMLDocument('');
    const close = vi.fn();
    const replace = vi.fn();
    const popup = {
      closed: false,
      close,
      document: popupDocument,
      location: { replace },
      opener: window,
    } as unknown as Window;
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/templates/validate') {
        return jsonResponse({ error: 'Template test service is temporarily unavailable.' }, 500);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /test in new tab/i }));

    expect(await screen.findByText(/template test service is temporarily unavailable/i)).toBeInTheDocument();
    expect(openSpy).toHaveBeenCalledWith('about:blank', 'magicbooklet-template-consumer-test');
    expect(popupDocument.title).toMatch(/test setup needs attention.*magicbooklet/i);
    expect(popupDocument.body.textContent).toMatch(/we couldn’t prepare this test/i);
    expect(popupDocument.body.textContent).toMatch(/template test service is temporarily unavailable/i);
    expect(popupDocument.body.textContent).toMatch(/return to the workflow tab/i);
    expect(close).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('restores a needs-attention test without idle polling and refreshes it when the creator returns', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const clientPathHash = currentPathHash(graph, output.id);
    window.localStorage.setItem(`magicbooklet:template-test:canvas-1:${output.id}`, JSON.stringify({
      run: { id: 'run-1', status: 'needs_attention', errorMessage: 'Generation provider timed out.' },
      context: {
        canvasRevision: 2,
        clientPathHash,
        graphHash: 'server-graph-hash',
        templateId: 'template-1',
      },
    }));

    let runFetchCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/templates/template-1') {
        return jsonResponse({
          template: {
            id: 'template-1',
            name: 'Ghost rider transformation',
            authoring: { outputNodeId: output.id, sourceCanvasId: 'canvas-1' },
          },
        });
      }
      if (url === '/api/template-runs/run-1') {
        runFetchCount += 1;
        return jsonResponse({
          run: runFetchCount === 1
            ? { id: 'run-1', status: 'needs_attention', errorMessage: 'Generation provider timed out.' }
            : { id: 'run-1', status: 'succeeded' },
        });
      }
      if (url === '/api/templates/validate') return jsonResponse(validationResponse(20));
      throw new Error(`Unexpected request: ${url}`);
    }));

    renderDrawer({ credits: 200, templateId: 'template-1' });

    expect(await screen.findByText('Test needs attention')).toBeInTheDocument();
    await waitFor(() => expect(runFetchCount).toBe(1));
    expect(setIntervalSpy.mock.calls.some(([, delay]) => delay === 4000)).toBe(false);
    expect(screen.getByRole('button', { name: /open test issue/i })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /validate/i }));
    await screen.findByText(/saved and validated workflow revision 2/i);
    expect(screen.getByRole('status')).toHaveTextContent(/open the test that needs attention and retry/i);

    fireEvent(window, new Event('focus'));
    expect(await screen.findByText('Consumer test passed')).toBeInTheDocument();
    expect(runFetchCount).toBe(2);
    expect(screen.getByRole('button', { name: /^publish$/i })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/confirm you have permission/i);
    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => expect(screen.getByRole('button', { name: /^publish$/i })).toBeEnabled());
    expect(screen.getByRole('status')).toHaveTextContent(/ready to publish this tested revision/i);
  });

  it('restores a returned successful test from the server without local storage', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/templates/template-1') {
        return jsonResponse({
          template: {
            id: 'template-1',
            name: 'Ghost rider transformation',
            authoring: { outputNodeId: output.id, sourceCanvasId: 'canvas-1' },
          },
        });
      }
      if (url === '/api/template-runs/run-returned') {
        return jsonResponse({
          run: {
            id: 'run-returned',
            status: 'succeeded',
            isTest: true,
            templateId: 'template-1',
          },
        });
      }
      if (url === '/api/templates/validate') return jsonResponse(validationResponse(20));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDrawer({
      initialTestRunId: 'run-returned',
      templateId: 'template-1',
    });

    expect(await screen.findByText('Consumer test passed')).toBeInTheDocument();
    expect(screen.getByText(/consumer test restored and passed/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/template-runs/run-returned', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('/api/templates/validate', expect.objectContaining({ method: 'POST' }));
    await waitFor(() => {
      expect(window.localStorage.getItem(`magicbooklet:template-test:canvas-1:${output.id}`)).toContain('run-returned');
    });

    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByRole('button', { name: /^publish$/i })).toBeEnabled());
  });
});
