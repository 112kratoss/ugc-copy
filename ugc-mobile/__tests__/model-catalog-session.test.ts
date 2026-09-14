import { describe, expect, it, vi } from 'vitest';
import fixture from '../../contracts/model-catalog-transport-v1.json';
import {
  ModelCatalogSession,
  type CatalogTransport,
} from '../lib/model-catalog-session';
import { parseModelCatalogDetail } from '../lib/generation-model-catalog';
function transport() {
  return vi.fn<CatalogTransport>(async (path) => ({
    body: path.endsWith('/current')
      ? fixture.current
      : path.includes('/models?')
        ? fixture.page
        : fixture.details,
    etag: '"revision-1"',
    notModified: false,
  }));
}
describe('model catalog session', () => {
  it('loads an unknown model independently of static registries and preserves control conditions', async () => {
    const request = transport();
    const session = new ModelCatalogSession(request, parseModelCatalogDetail);
    await session.initialize();
    expect(request).toHaveBeenCalledTimes(1);
    await session.loadPage('image');
    expect(session.getSnapshot().details).toEqual([]);
    await session.ensureDetails(['future-image-model']);
    expect(
      session.getSnapshot().details[0].controls.at(-1)?.conditions,
    ).toEqual(fixture.details.models[0].controls.at(-1)?.conditions);
    expect(session.getSnapshot().summaries).toHaveLength(1);
  });
  it('ignores late details after a revision change, including rollback', async () => {
    const request = transport();
    const session = new ModelCatalogSession(request, parseModelCatalogDetail);
    await session.initialize();
    let resolve!: (v: Awaited<ReturnType<CatalogTransport>>) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const loading = session.ensureDetails(['future-image-model']);
    request.mockResolvedValueOnce({
      body: { ...fixture.current, revision: 'new-revision' },
      etag: '"new"',
      notModified: false,
    });
    await session.refresh();
    resolve({ body: fixture.details, etag: null, notModified: false });
    await loading;
    expect(session.getSnapshot().current?.revision).toBe('new-revision');
    expect(session.getSnapshot().details).toEqual([]);
    await session.refresh();
    expect(session.getSnapshot().current?.revision).toBe(
      fixture.current.revision,
    );
    expect(session.getSnapshot().details[0].id).toBe('future-image-model');
  });
  it('reports a missing selection without inventing or substituting another descriptor', async () => {
    const request = transport();
    const session = new ModelCatalogSession(request, parseModelCatalogDetail);
    await session.initialize();
    request.mockResolvedValueOnce({
      body: { ...fixture.details, models: [], missingIds: ['retired'] },
      etag: null,
      notModified: false,
    });
    await session.ensureDetails(['retired']);
    expect(session.getSnapshot().missingIds).toEqual(['retired']);
    expect(session.getSnapshot().details).toEqual([]);
  });
  it('hydrates cached details and ETag offline; corrupt and failing storage do not block network results', async () => {
    const storage = {
      getItem: vi.fn(async () =>
        JSON.stringify({
          current: fixture.current,
          etag: '"cached"',
          entries: [
            {
              revision: fixture.current.revision,
              descriptor: fixture.details.models[0],
            },
          ],
        }),
      ),
      setItem: vi.fn(async () => {}),
    };
    const request = transport();
    request.mockRejectedValueOnce(new Error('offline'));
    const session = new ModelCatalogSession(
      request,
      parseModelCatalogDetail,
      storage,
    );
    await session.initialize();
    expect(request).toHaveBeenCalledWith(
      '/api/model-catalog/v1/current',
      '"cached"',
    );
    expect(session.getSnapshot().details).toHaveLength(1);
    await session.refresh();
    expect(session.getSnapshot().error).toBeNull();
    storage.getItem.mockResolvedValueOnce('{broken');
    storage.setItem.mockRejectedValue(new Error('quota'));
    const fresh = new ModelCatalogSession(
      transport(),
      parseModelCatalogDetail,
      storage,
    );
    await fresh.initialize();
    expect(fresh.getSnapshot().current).toEqual(fixture.current);
  });
  it('batches eight at a time with two workers and deduplicates matching requests', async () => {
    let concurrent = 0,
      maxConcurrent = 0;
    const request = transport();
    request.mockImplementation(async (path) => {
      if (path.endsWith('/current'))
        return { body: fixture.current, etag: null, notModified: false };
      const ids = new URL('https://test' + path).searchParams
        .get('ids')!
        .split(',');
      expect(ids.length).toBeLessThanOrEqual(8);
      maxConcurrent = Math.max(maxConcurrent, ++concurrent);
      await new Promise((r) => setTimeout(r, 2));
      concurrent--;
      return {
        body: {
          ...fixture.details,
          models: ids.map((id) => ({ ...fixture.details.models[0], id })),
          missingIds: [],
        },
        etag: null,
        notModified: false,
      };
    });
    const session = new ModelCatalogSession(request, parseModelCatalogDetail);
    await session.initialize();
    const ids = Array.from({ length: 24 }, (_, i) => 'future-' + i);
    await Promise.all([session.ensureDetails(ids), session.ensureDetails(ids)]);
    expect(request).toHaveBeenCalledTimes(4);
    expect(maxConcurrent).toBe(2);
    expect(session.getSnapshot().details).toHaveLength(24);
  });
});

it('bounds cached revisions and descriptors while protecting an open draft', async () => {
  let revision = 'r1';
  let saved = '';
  const request: CatalogTransport = async (path) => {
    const ids =
      new URL('https://test' + path).searchParams.get('ids')?.split(',') ?? [];
    return {
      body: path.endsWith('/current')
        ? { ...fixture.current, revision }
        : {
            ...fixture.details,
            revision,
            models: ids.map((id) => ({ ...fixture.details.models[0], id })),
            missingIds: [],
          },
      etag: null,
      notModified: false,
    };
  };
  const session = new ModelCatalogSession(request, parseModelCatalogDetail, {
    getItem: () => null,
    setItem: (_key, value) => {
      saved = value;
    },
  });
  await session.initialize();
  session.pin(['open-draft']);
  await session.ensureDetails(['open-draft']);
  await session.ensureDetails(
    Array.from({ length: 120 }, (_, i) => `model-${i}`),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(session.getSnapshot().details.length).toBeLessThanOrEqual(100);
  expect(
    session.getSnapshot().details.some((model) => model.id === 'open-draft'),
  ).toBe(true);
  expect(JSON.parse(saved).entries).toHaveLength(100);
  for (revision of ['r2', 'r3']) {
    await session.refresh();
    await session.ensureDetails(['open-draft']);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    new Set(
      JSON.parse(saved).entries.map(
        (entry: { revision: string }) => entry.revision,
      ),
    ),
  ).toEqual(new Set(['r2', 'r3']));
});

it('deduplicates overlapping detail groups and retains the revision on a 304', async () => {
  const request = transport();
  const session = new ModelCatalogSession(request, parseModelCatalogDetail);
  await session.initialize();
  const seen: string[] = [];
  request.mockImplementation(async (path) => {
    const ids = new URL('https://test' + path).searchParams
      .get('ids')!
      .split(',');
    seen.push(...ids);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return {
      body: {
        ...fixture.details,
        models: ids.map((id) => ({ ...fixture.details.models[0], id })),
        missingIds: [],
      },
      etag: null,
      notModified: false,
    };
  });
  await Promise.all([
    session.ensureDetails(['a', 'b']),
    session.ensureDetails(['b', 'c']),
  ]);
  expect(seen.sort()).toEqual(['a', 'b', 'c']);
  const current = session.getSnapshot().current;
  request.mockResolvedValueOnce({
    body: null,
    etag: '"same"',
    notModified: true,
  });
  await session.refresh();
  expect(session.getSnapshot().current).toBe(current);
  expect(session.getSnapshot().details).toHaveLength(3);
});
