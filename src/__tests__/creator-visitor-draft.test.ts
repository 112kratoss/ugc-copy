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

describe('a visitor’s creator draft and the sign-in that comes back for it', () => {
  beforeEach(() => {
    store.clear();
    window.localStorage.clear();
    vi.resetModules();
  });

  it('moves the marked creator’s draft and files to the account that came back with the nonce, replacing what it held for that creator', async () => {
    const { adoptVisitorDraft, hasVisitorDraftHandover, markVisitorDraftForHandover } = await loadModule();
    store.set('creator-draft:video:visitor', { version: 1, draft: { prompt: 'A paper boat' } });
    store.set('create-video:start-image:visitor', { name: 'boat.png' });
    // The account's older draft for the same creator, with a picture the visitor never saw.
    store.set(`creator-draft:video:${USER}`, { version: 1, draft: { prompt: 'Old idea' } });
    store.set(`create-video:end-image:${USER}`, { name: 'old-end.png' });
    // Another creator's drafts are not touched.
    store.set('creator-draft:image:visitor', { version: 1, draft: { prompt: 'Visitor image' } });
    store.set(`creator-draft:image:${USER}`, { version: 1, draft: { prompt: 'Account image' } });

    const nonce = markVisitorDraftForHandover('video', NOW);
    expect(nonce).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(hasVisitorDraftHandover('video', nonce, NOW + 1000)).toBe(true);
    expect(hasVisitorDraftHandover('image', nonce, NOW + 1000)).toBe(false);
    await expect(adoptVisitorDraft('video', USER, nonce, NOW + 5 * 60 * 1000)).resolves.toBe(true);

    expect(store.get(`creator-draft:video:${USER}`)).toEqual({ version: 1, draft: { prompt: 'A paper boat' } });
    expect(store.get(`create-video:start-image:${USER}`)).toEqual({ name: 'boat.png' });
    expect(store.has(`create-video:end-image:${USER}`)).toBe(false);
    expect(store.has('creator-draft:video:visitor')).toBe(false);
    expect(store.has('create-video:start-image:visitor')).toBe(false);
    expect(window.localStorage.getItem(MARK_KEY)).toBeNull();
    expect(store.get(`creator-draft:image:${USER}`)).toEqual({ version: 1, draft: { prompt: 'Account image' } });
    expect(store.get('creator-draft:image:visitor')).toEqual({ version: 1, draft: { prompt: 'Visitor image' } });
  });

  it('moves nothing for a sign-in that did not start at the sheet: an abandoned sign-up’s mark is no one else’s', async () => {
    const { adoptVisitorDraft, markVisitorDraftForHandover } = await loadModule();
    store.set('creator-draft:video:visitor', { version: 1, draft: { prompt: 'Someone else' } });
    store.set('create-video:start-image:visitor', { name: 'theirs.png' });
    store.set(`creator-draft:video:${USER}`, { version: 1, draft: { prompt: 'Mine' } });
    markVisitorDraftForHandover('video', NOW);

    // The top bar's Sign in, or another account later, comes back with no nonce or another one.
    await expect(adoptVisitorDraft('video', USER, null, NOW + 1000)).resolves.toBe(false);
    await expect(adoptVisitorDraft('video', USER, 'another-nonce-1234', NOW + 1000)).resolves.toBe(false);

    expect(store.get(`creator-draft:video:${USER}`)).toEqual({ version: 1, draft: { prompt: 'Mine' } });
    expect(store.has(`create-video:start-image:${USER}`)).toBe(false);
    expect(store.get('creator-draft:video:visitor')).toEqual({ version: 1, draft: { prompt: 'Someone else' } });
  });

  it('moves nothing on another creator’s page, or after the hour, or from a clock that went back', async () => {
    const { adoptVisitorDraft, markVisitorDraftForHandover, VISITOR_DRAFT_HANDOVER_MAX_AGE_MS } = await loadModule();
    expect(VISITOR_DRAFT_HANDOVER_MAX_AGE_MS).toBe(HOUR_MS);
    store.set('creator-draft:motion:visitor', { version: 1, draft: { prompt: 'Dance' } });

    const nonce = markVisitorDraftForHandover('motion', NOW);
    await expect(adoptVisitorDraft('video', USER, nonce, NOW + 1000)).resolves.toBe(false);
    await expect(adoptVisitorDraft('motion', USER, nonce, NOW + HOUR_MS + 1)).resolves.toBe(false);
    await expect(adoptVisitorDraft('motion', USER, nonce, NOW - 1)).resolves.toBe(false);
    expect(store.has(`creator-draft:motion:${USER}`)).toBe(false);

    await expect(adoptVisitorDraft('motion', USER, nonce, NOW + 2000)).resolves.toBe(true);
    expect(store.get(`creator-draft:motion:${USER}`)).toEqual({ version: 1, draft: { prompt: 'Dance' } });
  });

  it('spends the mark, so a reload of the same address moves nothing again', async () => {
    const { adoptVisitorDraft, markVisitorDraftForHandover } = await loadModule();
    store.set('creator-draft:video:visitor', { version: 1, draft: { prompt: 'Once' } });
    const nonce = markVisitorDraftForHandover('video', NOW);

    await expect(adoptVisitorDraft('video', USER, nonce, NOW + 1000)).resolves.toBe(true);
    store.set(`creator-draft:video:${USER}`, { version: 1, draft: { prompt: 'Edited since' } });
    await expect(adoptVisitorDraft('video', USER, nonce, NOW + 2000)).resolves.toBe(false);
    expect(store.get(`creator-draft:video:${USER}`)).toEqual({ version: 1, draft: { prompt: 'Edited since' } });
  });

  it('reads an unreadable mark as none', async () => {
    const { hasVisitorDraftHandover } = await loadModule();
    window.localStorage.setItem(MARK_KEY, '{"tool":"video","nonce":"abcdefgh"}');
    expect(hasVisitorDraftHandover('video', 'abcdefgh', NOW)).toBe(false);
    window.localStorage.setItem(MARK_KEY, 'not json');
    expect(hasVisitorDraftHandover('video', 'abcdefgh', NOW)).toBe(false);
  });

  it('never moves a draft onto the visitor itself', async () => {
    const { adoptVisitorDraft, markVisitorDraftForHandover, VISITOR_DRAFT_OWNER } = await loadModule();
    const nonce = markVisitorDraftForHandover('video', NOW);
    await expect(adoptVisitorDraft('video', VISITOR_DRAFT_OWNER, nonce, NOW)).resolves.toBe(false);
    expect(window.localStorage.getItem(MARK_KEY)).not.toBeNull();
  });

  it('answers no nonce, and hands nothing over, where the browser keeps nothing', async () => {
    const { markVisitorDraftForHandover } = await loadModule();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage refused', 'SecurityError');
    });
    try {
      expect(markVisitorDraftForHandover('video', NOW)).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });
});
