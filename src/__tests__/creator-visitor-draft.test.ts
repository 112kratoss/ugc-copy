import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();

vi.mock('localforage', () => ({
  default: {
    createInstance: () => ({
      async getItem<T>(key: string) {
        return (store.get(key) as T | undefined) ?? null;
      },
      async setItem<T>(key: string, value: T) {
        store.set(key, value);
        return value;
      },
      async removeItem(key: string) {
        store.delete(key);
      },
      async dropInstance() {},
    }),
  },
}));

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const USER = '6b3f6c2e-8f1a-4c41-9b1a-0c7e2d1f5a10';
const MARK_KEY = 'magicbooklet:creator-draft-handover';

async function loadModule() {
  return import('@/lib/creator-visitor-draft');
}

describe('a visitor’s creator draft and the account that signs in', () => {
  beforeEach(() => {
    store.clear();
    window.localStorage.clear();
    vi.resetModules();
  });

  it('moves the marked creator’s draft and files to the account, replacing what the account held for that creator', async () => {
    const { adoptVisitorDraft, hasVisitorDraftHandover, markVisitorDraftForHandover } = await loadModule();
    store.set('creator-draft:video:visitor', { version: 1, draft: { prompt: 'A paper boat' } });
    store.set('create-video:start-image:visitor', { name: 'boat.png' });
    // The account's older draft for the same creator, with a picture the visitor never saw.
    store.set(`creator-draft:video:${USER}`, { version: 1, draft: { prompt: 'Old idea' } });
    store.set(`create-video:end-image:${USER}`, { name: 'old-end.png' });
    // Another creator's drafts are not touched.
    store.set('creator-draft:image:visitor', { version: 1, draft: { prompt: 'Visitor image' } });
    store.set(`creator-draft:image:${USER}`, { version: 1, draft: { prompt: 'Account image' } });

    markVisitorDraftForHandover('video', NOW);
    expect(hasVisitorDraftHandover('video', NOW + 1000)).toBe(true);
    expect(hasVisitorDraftHandover('image', NOW + 1000)).toBe(false);
    await expect(adoptVisitorDraft('video', USER, NOW + 5 * 60 * 1000)).resolves.toBe(true);

    expect(store.get(`creator-draft:video:${USER}`)).toEqual({ version: 1, draft: { prompt: 'A paper boat' } });
    expect(store.get(`create-video:start-image:${USER}`)).toEqual({ name: 'boat.png' });
    expect(store.has(`create-video:end-image:${USER}`)).toBe(false);
    expect(store.has('creator-draft:video:visitor')).toBe(false);
    expect(store.has('create-video:start-image:visitor')).toBe(false);
    expect(window.localStorage.getItem(MARK_KEY)).toBeNull();
    expect(store.get(`creator-draft:image:${USER}`)).toEqual({ version: 1, draft: { prompt: 'Account image' } });
    expect(store.get('creator-draft:image:visitor')).toEqual({ version: 1, draft: { prompt: 'Visitor image' } });
  });

  it('moves nothing without a mark, so the next person to sign in never opens a visitor’s pictures', async () => {
    const { adoptVisitorDraft, hasVisitorDraftHandover } = await loadModule();
    store.set('creator-draft:video:visitor', { version: 1, draft: { prompt: 'Someone else' } });
    store.set('create-video:start-image:visitor', { name: 'theirs.png' });

    expect(hasVisitorDraftHandover('video', NOW)).toBe(false);
    await expect(adoptVisitorDraft('video', USER, NOW)).resolves.toBe(false);

    expect(store.has(`creator-draft:video:${USER}`)).toBe(false);
    expect(store.has(`create-video:start-image:${USER}`)).toBe(false);
    expect(store.get('creator-draft:video:visitor')).toEqual({ version: 1, draft: { prompt: 'Someone else' } });
  });

  it('leaves a mark for another creator to that creator', async () => {
    const { adoptVisitorDraft, markVisitorDraftForHandover } = await loadModule();
    store.set('creator-draft:motion:visitor', { version: 1, draft: { prompt: 'Dance' } });
    markVisitorDraftForHandover('motion', NOW);

    await expect(adoptVisitorDraft('video', USER, NOW + 1000)).resolves.toBe(false);
    expect(window.localStorage.getItem(MARK_KEY)).not.toBeNull();

    await expect(adoptVisitorDraft('motion', USER, NOW + 2000)).resolves.toBe(true);
    expect(store.get(`creator-draft:motion:${USER}`)).toEqual({ version: 1, draft: { prompt: 'Dance' } });
  });

  it('drops a mark older than an hour, or from a clock that has gone back, and moves nothing', async () => {
    const { adoptVisitorDraft, hasVisitorDraftHandover, markVisitorDraftForHandover, VISITOR_DRAFT_HANDOVER_MAX_AGE_MS } = await loadModule();
    expect(VISITOR_DRAFT_HANDOVER_MAX_AGE_MS).toBe(HOUR_MS);
    store.set('creator-draft:video:visitor', { version: 1, draft: { prompt: 'Stale' } });

    markVisitorDraftForHandover('video', NOW);
    expect(hasVisitorDraftHandover('video', NOW + HOUR_MS + 1)).toBe(false);
    await expect(adoptVisitorDraft('video', USER, NOW + HOUR_MS + 1)).resolves.toBe(false);
    expect(window.localStorage.getItem(MARK_KEY)).toBeNull();
    expect(store.has(`creator-draft:video:${USER}`)).toBe(false);

    markVisitorDraftForHandover('video', NOW);
    await expect(adoptVisitorDraft('video', USER, NOW - 1)).resolves.toBe(false);
    expect(window.localStorage.getItem(MARK_KEY)).toBeNull();
  });

  it('drops an unreadable mark', async () => {
    const { adoptVisitorDraft } = await loadModule();
    window.localStorage.setItem(MARK_KEY, '{"tool":"video"}');
    await expect(adoptVisitorDraft('video', USER, NOW)).resolves.toBe(false);
    expect(window.localStorage.getItem(MARK_KEY)).toBeNull();

    window.localStorage.setItem(MARK_KEY, 'not json');
    await expect(adoptVisitorDraft('video', USER, NOW)).resolves.toBe(false);
    expect(window.localStorage.getItem(MARK_KEY)).toBeNull();
  });

  it('never moves a draft onto the visitor itself', async () => {
    const { adoptVisitorDraft, markVisitorDraftForHandover, VISITOR_DRAFT_OWNER } = await loadModule();
    markVisitorDraftForHandover('video', NOW);
    await expect(adoptVisitorDraft('video', VISITOR_DRAFT_OWNER, NOW)).resolves.toBe(false);
    expect(window.localStorage.getItem(MARK_KEY)).not.toBeNull();
  });
});
