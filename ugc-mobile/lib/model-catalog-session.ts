import {
  parseModelCatalogCurrent,
  parseModelCatalogPage,
  type ModelCatalogCurrent,
  type ModelCatalogKind,
  type ModelCatalogSummary,
  type ModelCatalogDetails,
} from './model-catalog-protocol';

export type CatalogTransport = (
  path: string,
  etag?: string,
) => Promise<{ body: unknown; etag: string | null; notModified: boolean }>;
export type CatalogPersistence = {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
};
export type CatalogDescriptorIdentity = { id: string; kind: ModelCatalogKind };
export type CatalogSessionState<T> = {
  current: ModelCatalogCurrent | null;
  summaries: ModelCatalogSummary[];
  details: T[];
  missingIds: string[];
  nextCursors: Partial<Record<ModelCatalogKind | 'all', string | null>>;
  error: Error | null;
  loading: boolean;
  loadingDetails: boolean;
};
const STORAGE_KEY = 'model-catalog:transport-v1';
const BASE = '/api/model-catalog/v1';

/** Each session owns one visible revision. Historical cache entries cannot become current by accident. */
export class ModelCatalogSession<T extends CatalogDescriptorIdentity> {
  private state: CatalogSessionState<T> = {
    current: null,
    summaries: [],
    details: [],
    missingIds: [],
    nextCursors: {},
    error: null,
    loading: false,
    loadingDetails: false,
  };
  private listeners = new Set<() => void>();
  private pending = new Map<string, Promise<void>>();
  private pendingIds = new Map<string, Promise<void>>();
  private cached = new Map<string, { revision: string; descriptor: T }>();
  private pinned = new Set<string>();
  private etag: string | null = null;
  private initialized = false;
  private activeDetailReads = 0;
  private detailWaiters: Array<() => void> = [];
  private pendingDetailGroups = 0;
  private saveQueue: Promise<void> = Promise.resolve();
  constructor(
    private transport: CatalogTransport,
    private parseDescriptor: (value: unknown) => T,
    private storage?: CatalogPersistence,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<CatalogSessionState<T>>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private run(key: string, action: () => Promise<void>): Promise<void> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = action().finally(() => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }
  async initialize() {
    return this.run('initialize', async () => {
      if (this.initialized) return;
      this.initialized = true;
      try {
        const raw = await this.storage?.getItem(STORAGE_KEY);
        if (raw) {
          const value = JSON.parse(raw);
          const current = parseModelCatalogCurrent(value.current);
          if (Array.isArray(value.entries))
            for (const entry of value.entries.slice(-100)) {
              if (typeof entry.revision !== 'string') continue;
              try {
                const descriptor = this.parseDescriptor(entry.descriptor);
                this.cached.set(`${entry.revision}:${descriptor.id}`, {
                  revision: entry.revision,
                  descriptor,
                });
              } catch {
                /* Discard a corrupt entry independently. */
              }
            }
          const summaries = value.page
            ? parseModelCatalogPage(value.page, current.revision).models
            : [];
          this.etag = typeof value.etag === 'string' ? value.etag : null;
          this.update({
            current,
            summaries,
            details: [...this.cached.values()]
              .filter((e) => e.revision === current.revision)
              .map((e) => e.descriptor),
          });
        }
      } catch {
        /* Storage is optional; network loading still proceeds. */
      }
      this.persist();
      await this.refresh();
    });
  }
  refresh = async () =>
    this.run('current', async () => {
      this.update({ loading: true, error: null });
      try {
        const result = await this.transport(
          `${BASE}/current`,
          this.etag ?? undefined,
        );
        if (result.notModified && this.state.current) return;
        const current = parseModelCatalogCurrent(result.body);
        this.etag = result.etag;
        if (current.revision !== this.state.current?.revision)
          this.update({
            current,
            summaries: [],
            nextCursors: {},
            missingIds: [],
            details: [...this.cached.values()]
              .filter((e) => e.revision === current.revision)
              .map((e) => e.descriptor),
          });
        else this.update({ current });
        this.persist();
      } catch (error) {
        this.update({
          error:
            error instanceof Error
              ? error
              : new Error('Could not refresh models.'),
        });
      } finally {
        this.update({ loading: false });
      }
    });
  pin(ids: string[]) {
    this.pinned = new Set(ids);
  }
  loadPage = async (kind: ModelCatalogKind | null = null) => {
    const current = this.state.current;
    if (!current) return;
    const key = kind ?? 'all';
    const cursor = this.state.nextCursors[key];
    if (cursor === null) return;
    return this.run(
      `page:${current.revision}:${key}:${cursor ?? ''}`,
      async () => {
        try {
          const params = new URLSearchParams({
            revision: current.revision,
            limit: '32',
          });
          if (kind) params.set('kind', kind);
          if (cursor) params.set('cursor', cursor);
          const response = await this.transport(`${BASE}/models?${params}`);
          const page = parseModelCatalogPage(response.body, current.revision);
          if (this.state.current?.revision !== current.revision) return;
          const summaries = new Map(this.state.summaries.map((m) => [m.id, m]));
          page.models.forEach((m) => summaries.set(m.id, m));
          this.update({
            summaries: [...summaries.values()].sort(
              (a, b) =>
                a.sortOrder - b.sortOrder ||
                (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            ),
            nextCursors: { ...this.state.nextCursors, [key]: page.nextCursor },
            error: null,
          });
          this.persist();
        } catch (error) {
          if (this.state.current?.revision === current.revision)
            this.update({
              error:
                error instanceof Error
                  ? error
                  : new Error('Could not load models.'),
            });
        }
      },
    );
  };
  ensureDetails = async (requested: string[]) => {
    const revision = this.state.current?.revision;
    if (!revision) return;
    const wanted = [...new Set(requested.filter(Boolean))];
    const waiting = wanted
      .map((id) => this.pendingIds.get(`${revision}:${id}`))
      .filter((value): value is Promise<void> => Boolean(value));
    const ids = wanted
      .filter(
        (id) =>
          !this.cached.has(`${revision}:${id}`) &&
          !this.state.details.some((model) => model.id === id) &&
          !this.state.missingIds.includes(id) &&
          !this.pendingIds.has(`${revision}:${id}`),
      )
      .sort();
    if (!ids.length) {
      await Promise.all(waiting);
      return;
    }
    const loading = this.run(
      `details:${revision}:${ids.join(',')}`,
      async () => {
        this.pendingDetailGroups++;
        this.update({ loadingDetails: true });
        const batches: string[][] = [];
        for (let i = 0; i < ids.length; i += 8)
          batches.push(ids.slice(i, i + 8));
        const worker = async () => {
          while (batches.length) {
            const batch = batches.shift()!;
            try {
              const params = new URLSearchParams({
                revision,
                ids: batch.join(','),
              });
              if (this.activeDetailReads >= 2)
                await new Promise<void>((resolve) =>
                  this.detailWaiters.push(resolve),
                );
              else this.activeDetailReads++;
              let response: Awaited<ReturnType<CatalogTransport>>;
              try {
                response = await this.transport(`${BASE}/details?${params}`);
              } finally {
                const next = this.detailWaiters.shift();
                if (next) next();
                else this.activeDetailReads--;
              }
              const body = response.body as ModelCatalogDetails;
              if (
                !body ||
                body.transportVersion !== 1 ||
                body.descriptorSchemaVersion !== 3 ||
                body.revision !== revision ||
                !Array.isArray(body.models) ||
                !Array.isArray(body.missingIds)
              )
                throw new Error('Invalid model details.');
              const details = body.models.map(this.parseDescriptor);
              const returnedIds = [
                ...details.map((m) => m.id),
                ...body.missingIds,
              ];
              if (
                returnedIds.length !== batch.length ||
                new Set(returnedIds).size !== batch.length ||
                returnedIds.some((id) => !batch.includes(id))
              )
                throw new Error('Incomplete model details.');
              details.forEach((descriptor) =>
                this.cached.set(`${revision}:${descriptor.id}`, {
                  revision,
                  descriptor,
                }),
              );
              if (this.state.current?.revision !== revision) {
                this.persist();
                continue;
              }
              const visible = new Map(this.state.details.map((m) => [m.id, m]));
              details.forEach((m) => visible.set(m.id, m));
              this.update({
                details: [...visible.values()],
                missingIds: [
                  ...new Set([...this.state.missingIds, ...body.missingIds]),
                ],
                error: null,
              });
              this.persist();
            } catch (error) {
              if (this.state.current?.revision === revision)
                this.update({
                  error:
                    error instanceof Error
                      ? error
                      : new Error('Could not load model settings.'),
                });
            }
          }
        };
        try {
          await Promise.all([worker(), worker()]);
        } finally {
          this.pendingDetailGroups--;
          this.update({ loadingDetails: this.pendingDetailGroups > 0 });
        }
      },
    );
    ids.forEach((id) => this.pendingIds.set(`${revision}:${id}`, loading));
    try {
      await Promise.all([...waiting, loading]);
    } finally {
      ids.forEach((id) => {
        if (this.pendingIds.get(`${revision}:${id}`) === loading)
          this.pendingIds.delete(`${revision}:${id}`);
      });
    }
  };
  retry = async () => {
    this.update({ missingIds: [], error: null });
    await this.refresh();
  };
  private persist() {
    const current = this.state.current;
    if (!current) return;
    const revisions = [
      current.revision,
      ...[...new Set([...this.cached.values()].map((e) => e.revision))]
        .reverse()
        .filter((r) => r !== current.revision),
    ].slice(0, 2);
    for (const [key, entry] of this.cached)
      if (!revisions.includes(entry.revision)) this.cached.delete(key);
    for (const [key, entry] of this.cached) {
      if (this.cached.size <= 100) break;
      if (
        !(
          entry.revision === current.revision &&
          this.pinned.has(entry.descriptor.id)
        )
      )
        this.cached.delete(key);
    }
    // Open workflows may reference more than the persistence cap. Keep their
    // live descriptors, while disk and the reusable cache remain bounded.
    while (this.cached.size > 100)
      this.cached.delete(this.cached.keys().next().value!);
    const retained = this.state.details.filter(
      (descriptor) =>
        this.cached.has(`${current.revision}:${descriptor.id}`) ||
        this.pinned.has(descriptor.id),
    );
    if (retained.length !== this.state.details.length)
      this.update({ details: retained });
    const entries = [...this.cached.values()].slice(-100);
    const value = JSON.stringify({
      current,
      etag: this.etag,
      entries,
      page: {
        transportVersion: 1,
        revision: current.revision,
        models: this.state.summaries.slice(0, 50),
        nextCursor: null,
      },
    });
    this.saveQueue = this.saveQueue
      .then(async () => {
        await this.storage?.setItem(STORAGE_KEY, value);
      })
      .catch(() => {});
  }
}
