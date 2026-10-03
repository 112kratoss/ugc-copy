import { describe, expect, it, vi } from 'vitest';
import fixture from '../../contracts/model-catalog-transport-v1.json';
import {
  ModelCatalogSession,
  type CatalogTransport,
} from '../lib/model-catalog/session';
import { parseModelCatalogDetail } from '../lib/generation-model-catalog';
function transport() {
  return vi.fn<CatalogTransport>(async (path) => ({
    body: path.includes('/current?')
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
      '/api/model-catalog/v1/current?platform=web',
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
  it('moves malformed model ids straight to missingIds instead of sending them with the batch', async () => {
    const request = transport();
    const session = new ModelCatalogSession(request, parseModelCatalogDetail);
    await session.initialize();
    await session.ensureDetails(['bad id', 'future-image-model']);
    const detailCalls = request.mock.calls.filter(([path]) =>
      path.includes('/details?'),
    );
    expect(detailCalls).toHaveLength(1);
    expect(
      new URL('https://test' + detailCalls[0][0]).searchParams.get('ids'),
    ).toBe('future-image-model');
    expect(session.getSnapshot().missingIds).toEqual(['bad id']);
    expect(session.getSnapshot().details.map((m) => m.id)).toEqual([
      'future-image-model',
    ]);
  });
  it('sends its platform on every read and does not rewrite a restored cache before the network answers', async () => {
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
    request.mockResolvedValueOnce({
      body: null,
      etag: '"cached"',
      notModified: true,
    });
    const session = new ModelCatalogSession(
      request,
      parseModelCatalogDetail,
      storage,
      'mobile',
    );
    await session.initialize();
    await session.loadPage('image');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot().details).toHaveLength(1);
    for (const [path] of request.mock.calls)
      expect(new URL('https://test' + path).searchParams.get('platform')).toBe(
        'mobile',
      );
    // A 304 keeps the restored revision; only the page result is worth a write.
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });
  it('batches eight at a time with two workers and deduplicates matching requests', async () => {
    let concurrent = 0,
      maxConcurrent = 0;
    const request = transport();
    request.mockImplementation(async (path) => {
      if (path.includes('/current?'))
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
      body: path.includes('/current?')
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

describe('ensureCurrent, for a caller about to commit to the revision', () => {
  /** A catalog whose current revision, model list and reachability a test can move. */
  function catalogServer() {
    const state = {
      revision: fixture.current.revision,
      removed: [] as string[],
      currentFails: false,
      detailsFail: false,
    };
    const request = vi.fn<CatalogTransport>(async (path, etag) => {
      const params = new URL('https://test' + path).searchParams;
      if (path.includes('/current?')) {
        if (state.currentFails) throw new Error('offline');
        const currentEtag = `"${state.revision}"`;
        return etag === currentEtag
          ? { body: null, etag: currentEtag, notModified: true }
          : {
              body: { ...fixture.current, revision: state.revision },
              etag: currentEtag,
              notModified: false,
            };
      }
      if (path.includes('/models?'))
        return {
          body: { ...fixture.page, revision: params.get('revision') },
          etag: null,
          notModified: false,
        };
      if (state.detailsFail) throw new Error('details unavailable');
      const ids = params.get('ids')!.split(',');
      return {
        body: {
          ...fixture.details,
          revision: params.get('revision'),
          models: ids
            .filter((id) => !state.removed.includes(id))
            .map((id) => ({ ...fixture.details.models[0], id })),
          missingIds: ids.filter((id) => state.removed.includes(id)),
        },
        etag: null,
        notModified: false,
      };
    });
    const reads = (endpoint: 'current' | 'details') =>
      request.mock.calls
        .filter(([path]) => path.includes(`/${endpoint}?`))
        .map(([path]) =>
          new URL('https://test' + path).searchParams.get('revision'),
        );
    return { state, request, reads };
  }
  async function openSession(ids: string[]) {
    const server = catalogServer();
    const session = new ModelCatalogSession(
      server.request,
      parseModelCatalogDetail,
    );
    await session.initialize();
    await session.ensureDetails(ids);
    return { ...server, session };
  }

  it('returns the revision published after the session opened, with the models loaded for it', async () => {
    const { state, session, reads } = await openSession(['image-a', 'video-b']);
    state.revision = 'published-later';
    // Nothing tells an open session about a release: it shows what it loaded.
    expect(session.getSnapshot().current?.revision).toBe(
      fixture.current.revision,
    );

    await expect(
      session.ensureCurrent(['image-a', 'video-b']),
    ).resolves.toEqual({
      revision: 'published-later',
      missingIds: [],
      ready: true,
      error: null,
    });
    expect(session.getSnapshot().current?.revision).toBe('published-later');
    expect(
      session
        .getSnapshot()
        .details.map((model) => model.id)
        .sort(),
    ).toEqual(['image-a', 'video-b']);
    expect(reads('details')).toEqual([
      fixture.current.revision,
      'published-later',
    ]);
  });
  it('names a model the release took away and is not ready', async () => {
    const { state, session } = await openSession(['image-a', 'video-b']);
    state.revision = 'published-later';
    state.removed = ['video-b'];

    await expect(
      session.ensureCurrent(['image-a', 'video-b']),
    ).resolves.toEqual({
      revision: 'published-later',
      missingIds: ['video-b'],
      ready: false,
      error: null,
    });
  });
  it('leaves out a missing model the caller did not ask about', async () => {
    const server = catalogServer();
    server.state.removed = ['no-longer-on-the-canvas'];
    const session = new ModelCatalogSession(
      server.request,
      parseModelCatalogDetail,
    );
    await session.initialize();
    await session.ensureDetails(['image-a', 'no-longer-on-the-canvas']);
    expect(session.getSnapshot().missingIds).toEqual([
      'no-longer-on-the-canvas',
    ]);

    await expect(session.ensureCurrent(['image-a'])).resolves.toEqual({
      revision: fixture.current.revision,
      missingIds: [],
      ready: true,
      error: null,
    });
  });
  it('gives no revision when the read fails, and the current one once it succeeds', async () => {
    const { state, session } = await openSession(['image-a']);
    state.currentFails = true;

    const failed = await session.ensureCurrent(['image-a']);
    expect(failed).toMatchObject({
      revision: null,
      missingIds: [],
      ready: false,
    });
    expect(failed.error?.message).toBe('offline');
    // The session keeps showing what it had. The caller is told not to use it.
    expect(session.getSnapshot().current?.revision).toBe(
      fixture.current.revision,
    );

    state.currentFails = false;
    state.revision = 'published-later';
    await expect(session.ensureCurrent(['image-a'])).resolves.toEqual({
      revision: 'published-later',
      missingIds: [],
      ready: true,
      error: null,
    });
  });
  it('is not ready when the new revision cannot say what its models are', async () => {
    const { state, session } = await openSession(['image-a']);
    state.revision = 'published-later';
    state.detailsFail = true;

    const check = await session.ensureCurrent(['image-a']);
    expect(check).toMatchObject({
      revision: 'published-later',
      missingIds: [],
      ready: false,
    });
    expect(check.error?.message).toBe('details unavailable');
  });
  it('costs one conditional read when nothing was published', async () => {
    const { session, request } = await openSession(['image-a']);
    const before = request.mock.calls.length;

    await expect(session.ensureCurrent(['image-a'])).resolves.toEqual({
      revision: fixture.current.revision,
      missingIds: [],
      ready: true,
      error: null,
    });
    const added = request.mock.calls.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0][0]).toContain('/current?');
    expect(added[0][1]).toBe(`"${fixture.current.revision}"`);
  });
  it('reports the failed read it waited for, even when the next read has already begun', async () => {
    const { state, session, request } = await openSession(['image-a']);
    state.currentFails = true;
    state.revision = 'published-later';
    const order: string[] = [];
    let finishNextRead!: () => void;
    // Another caller is first in line on the failing read, and starts a read
    // of its own the moment that one ends. Its answer does not arrive.
    const nextRead = session.refresh().then(() => {
      request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            order.push('next read began');
            finishNextRead = () =>
              resolve({
                body: { ...fixture.current, revision: state.revision },
                etag: null,
                notModified: false,
              });
          }),
      );
      return session.refresh();
    });

    const check = await session.ensureCurrent(['image-a']);
    order.push('check returned');
    expect(order).toEqual(['next read began', 'check returned']);
    // The revision the session shows was never confirmed: one read failed and
    // the other has not answered.
    expect(session.getSnapshot().current?.revision).toBe(
      fixture.current.revision,
    );
    expect(check).toMatchObject({ revision: null, ready: false });
    expect(check.error?.message).toBe('offline');

    finishNextRead();
    await nextRead;
    expect(session.getSnapshot().current?.revision).toBe('published-later');
  });
});
