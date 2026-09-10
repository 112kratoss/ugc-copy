import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowOutputThumbnail, WorkflowOutputThumbnails, useWorkflowOutputGenerationId } from '@/app/create-workflow/WorkflowOutputThumbnails';
import { createStarterGraph, type WorkflowCanvasNode } from '@/lib/workflow-canvas';

vi.mock('@/app/components/AuthProvider', () => ({ useAuth: () => ({ session: { access_token: 'fixture' } }) }));
const makeNodes = (count: number) => Array.from({ length: count }, (_, index) => {
  const node = structuredClone(createStarterGraph().nodes.find((entry) => entry.type === 'video-generate')!);
  node.id = `node-${index}`;
  node.data.runState = { ...node.data.runState, generationId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, outputUrl: `/original-${index}.mp4` };
  return node;
});
const fixtureResponse = (url: string) => {
  const ids = new URL(url, 'http://app.test').searchParams.get('ids')!.split(',');
  return { ok: true, json: async () => ({ generations: ids.map((id) => ({ id, media: { kind: 'video', previewUrl: `/poster-${id}.jpg` } })) }) };
};
function Fixture({ nodes }: { nodes: WorkflowCanvasNode[] }) {
  return <WorkflowOutputThumbnails nodes={nodes}>{nodes.map((node) => <WorkflowOutputThumbnail key={node.id} generationId={node.data.runState.generationId} />)}</WorkflowOutputThumbnails>;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('workflow output thumbnail delivery', () => {
  it('batches 51 outputs, deduplicates IDs and never mounts a video', async () => {
    const fetchMock = vi.fn(async (url: string) => fixtureResponse(url));
    vi.stubGlobal('fetch', fetchMock);
    const nodes = makeNodes(51);
    nodes.push({ ...nodes[0], id: 'duplicate' });
    const { container } = render(<Fixture nodes={nodes} />);
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(52));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[0][0], 'http://app.test').searchParams.get('ids')!.split(',')).toHaveLength(50);
    expect(new URL(fetchMock.mock.calls[1][0], 'http://app.test').searchParams.get('ids')!.split(',')).toHaveLength(1);
    expect(container.querySelector('video')).toBeNull();
  });

  it('does not refetch on drag or selection changes, but refreshes on reconnect', async () => {
    const fetchMock = vi.fn(async (url: string) => fixtureResponse(url));
    vi.stubGlobal('fetch', fetchMock);
    const nodes = makeNodes(2);
    const { container, rerender } = render(<Fixture nodes={nodes} />);
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2));
    rerender(<Fixture nodes={nodes.map((node) => ({ ...node, selected: true, position: { x: 500, y: 100 } }))} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('keeps placeholders after denied or corrupt previews without original-video fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false }).mockImplementationOnce(async (url: string) => fixtureResponse(url));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<Fixture nodes={makeNodes(1)} />);
    await act(async () => {});
    expect(container.querySelector('img')).toBeNull();
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container).toHaveTextContent('Open video');
  });

  it('retries a failed poster on reconnect even when the fresh descriptor returns the same URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => fixtureResponse(url)));
    const { container } = render(<Fixture nodes={makeNodes(1)} />);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
  });

  it('aborts stalled bodies and ignores stale results after changing graphs', async () => {
    vi.useFakeTimers();
    let finish!: (payload: unknown) => void;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => new Promise((resolve) => { finish = resolve; }) });
    vi.stubGlobal('fetch', fetchMock);
    const nodes = makeNodes(1);
    const { container, rerender } = render(<Fixture nodes={nodes} />);
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    rerender(<Fixture nodes={[]} />);
    await act(async () => { finish(await fixtureResponse(fetchMock.mock.calls[0][0]).json()); });
    expect(container.querySelector('img')).toBeNull();
  });
});

function SourceThumbnail({ outputUrl }: { outputUrl: string }) {
  const id = useWorkflowOutputGenerationId(null, outputUrl);
  return <WorkflowOutputThumbnail generationId={id} />;
}
it('reuses an exact generated output for input and approval posters without more requests', async () => {
  const fetchMock = vi.fn(async (url: string) => fixtureResponse(url));
  vi.stubGlobal('fetch', fetchMock);
  const nodes = makeNodes(1);
  const { container } = render(<WorkflowOutputThumbnails nodes={nodes}>
    <SourceThumbnail outputUrl="/original-0.mp4" /><SourceThumbnail outputUrl="/original-0.mp4" /><SourceThumbnail outputUrl="/unrelated.mp4" />
  </WorkflowOutputThumbnails>);
  await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll('video')).toHaveLength(0);
});
it('resolves a video approval with its own generation ID even without a generator node', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => fixtureResponse(url)));
  const node = makeNodes(1)[0];
  node.type = 'approval-gate';
  Object.assign(node.data, { mediaKind: 'video' });
  const { container } = render(<Fixture nodes={[node]} />);
  await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(1));
});
