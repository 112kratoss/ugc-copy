import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import WorkflowLibraryClient from '@/app/create-workflow/WorkflowLibraryClient';
import { createStarterGraph, type WorkflowCanvasRecord } from '@/lib/workflow-canvas';
import { createWorkflowCanvasLibrarySummary } from '@/lib/workflow-canvas-preview';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: {
      access_token: 'test-token',
      user: { id: 'user-1' },
    },
  }),
}));

function createCanvas(id: string, title: string, updatedAt: string): WorkflowCanvasRecord {
  return {
    id,
    title,
    graph: createStarterGraph(),
    created_at: updatedAt,
    updated_at: updatedAt,
    revision: 1,
    status: 'draft',
    published_at: null,
  };
}

function toListItem(canvas: WorkflowCanvasRecord) {
  return {
    id: canvas.id,
    title: canvas.title,
    updated_at: canvas.updated_at,
    revision: canvas.revision,
    status: canvas.status,
    published_at: canvas.published_at,
    ...createWorkflowCanvasLibrarySummary(canvas.graph),
  };
}

describe('WorkflowLibraryClient', () => {
  let canvases: Record<string, WorkflowCanvasRecord>;

  beforeEach(() => {
    mockPush.mockReset();
    canvases = {
      'canvas-1': createCanvas('canvas-1', 'Product launch flow', '2026-07-11T10:00:00.000Z'),
      'canvas-2': createCanvas('canvas-2', 'Avatar motion test', '2026-07-12T10:00:00.000Z'),
    };

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/api/workflow-canvases' && method === 'GET') {
        return {
          ok: true,
          json: async () => ({ canvases: Object.values(canvases).map(toListItem) }),
        } as Response;
      }

      if (url === '/api/workflow-canvases' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as { title?: string; graph?: WorkflowCanvasRecord['graph'] };
        const id = body.graph ? 'canvas-copy' : 'canvas-new';
        const created = {
          ...createCanvas(id, body.title || 'New workflow', '2026-07-12T12:00:00.000Z'),
          graph: body.graph ?? createStarterGraph(),
        };
        canvases[id] = created;
        return { ok: true, json: async () => ({ canvas: created }) } as Response;
      }

      const match = url.match(/^\/api\/workflow-canvases\/([^/]+)$/);
      if (match && method === 'GET') {
        return { ok: true, json: async () => ({ canvas: canvases[match[1]] }) } as Response;
      }

      if (match && method === 'PATCH') {
        const body = JSON.parse(String(init?.body || '{}')) as { title?: string };
        canvases[match[1]] = {
          ...canvases[match[1]],
          title: body.title || canvases[match[1]].title,
          updated_at: '2026-07-12T13:00:00.000Z',
          revision: canvases[match[1]].revision + 1,
        };
        return { ok: true, json: async () => ({ canvas: canvases[match[1]] }) } as Response;
      }

      if (match && method === 'DELETE') {
        delete canvases[match[1]];
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }));
  });

  it('shows preview-led cards, searches titles, and opens the selected canvas', async () => {
    render(<WorkflowLibraryClient />);

    expect(await screen.findByRole('heading', { name: 'Avatar motion test' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Product launch flow' })).toBeInTheDocument();
    expect(screen.getAllByText('6 nodes')).toHaveLength(2);
    expect(screen.getAllByText('Image')).toHaveLength(2);
    expect(screen.getAllByText('Video')).toHaveLength(2);
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

    fireEvent.change(screen.getByPlaceholderText('Search workflows'), { target: { value: 'avatar' } });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Product launch flow' })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open canvas Avatar motion test' }));
    expect(mockPush).toHaveBeenCalledWith('/create-workflow?canvas=canvas-2');
  });

  it('renames with an accessible dialog and restores focus when Escape closes it', async () => {
    render(<WorkflowLibraryClient />);
    const actions = await screen.findByRole('button', { name: 'Actions for Product launch flow' });
    actions.focus();
    fireEvent.click(actions);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    const dialog = screen.getByRole('dialog', { name: 'Give this canvas a clear name' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Workflow name' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(actions).toHaveFocus();

    fireEvent.click(actions);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Workflow name' }), { target: { value: 'Launch system' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    expect(await screen.findByRole('heading', { name: 'Launch system' })).toBeInTheDocument();
  });

  it('duplicates and deletes workflows without opening the editor', async () => {
    render(<WorkflowLibraryClient />);
    const actions = await screen.findByRole('button', { name: 'Actions for Avatar motion test' });
    fireEvent.click(actions);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

    expect(await screen.findByRole('heading', { name: 'Copy of Avatar motion test' })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Product launch flow' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete “Product launch flow”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete workflow' }));

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Product launch flow' })).not.toBeInTheDocument();
    });
  });
});
