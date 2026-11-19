import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Whether the browser holds a session cookie (@supabase/ssr keeps the session in it).
const cookie = vi.hoisted(() => ({ present: false }));
vi.mock('@/lib/supabase-auth-cookie', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase-auth-cookie')>()),
  hasSupabaseAuthCookie: () => cookie.present,
}));

import {
  BrowserSupabaseLoadError,
  loadBrowserSupabase,
  preloadBrowserSupabaseForSession,
  readBrowserSession,
  setBrowserSupabaseImportForTests,
  whenBrowserSessionCookie,
} from '@/lib/browser-session';

type ClientModule = typeof import('@/lib/supabase');

const SESSION = { access_token: 'token-1', user: { id: 'user-1' } };

/** The client's module as its chunk delivers it: a client whose `getSession` answers `SESSION`. */
function clientModule(): ClientModule {
  return { supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: SESSION } })) } } } as unknown as ClientModule;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// The browser's Supabase client left the first load of the creator, search and pricing pages
// (2026-11-19): it is loaded with its first use, and never for a browser with no session cookie.
describe('the browser session', () => {
  let importClient: ReturnType<typeof vi.fn<() => Promise<ClientModule>>>;

  beforeEach(() => {
    cookie.present = false;
    importClient = vi.fn(async () => clientModule());
    setBrowserSupabaseImportForTests(importClient);
  });

  afterEach(() => {
    setBrowserSupabaseImportForTests(null);
  });

  it('is none, and loads no client, in a browser with no session cookie: no read and no preload fetches it', async () => {
    expect(await readBrowserSession()).toBeNull();
    preloadBrowserSupabaseForSession();
    await settle();

    expect(importClient).not.toHaveBeenCalled();
  });

  it('is read with the client in a browser with one, which is loaded once for every reader', async () => {
    cookie.present = true;
    preloadBrowserSupabaseForSession();
    const reads = await Promise.all([readBrowserSession(), readBrowserSession()]);

    expect(reads).toEqual([SESSION, SESSION]);
    expect(importClient).toHaveBeenCalledTimes(1);
  });

  it('says a load that failed with an error of its own, carrying the cause, and asks again at the next call', async () => {
    cookie.present = true;
    const chunkError = new Error('Loading chunk 1p-ooj54jv0t9 failed.');
    importClient.mockRejectedValueOnce(chunkError);

    const failed = await readBrowserSession().catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(BrowserSupabaseLoadError);
    expect((failed as BrowserSupabaseLoadError).cause).toBe(chunkError);

    // Asked again: `next dev --webpack` fetches the chunk anew, where a production build's runtime
    // hands the same failed load back (the pages that read the session offer a reload for that).
    expect(await readBrowserSession()).toEqual(SESSION);
    expect(importClient).toHaveBeenCalledTimes(2);
  });

  it('leaves nothing unhandled when a preload fails: the first read reports it', async () => {
    cookie.present = true;
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      importClient.mockRejectedValueOnce(new Error('Loading chunk failed.'));
      preloadBrowserSupabaseForSession();
      await settle();
      await settle();

      expect(unhandled).not.toHaveBeenCalled();
      await expect(loadBrowserSupabase()).resolves.toBeTruthy();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('whenBrowserSessionCookie', () => {
  let added: ReturnType<typeof vi.spyOn>;
  let removed: ReturnType<typeof vi.spyOn>;
  let addedToDocument: ReturnType<typeof vi.spyOn>;
  let removedFromDocument: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cookie.present = false;
    added = vi.spyOn(window, 'addEventListener');
    removed = vi.spyOn(window, 'removeEventListener');
    addedToDocument = vi.spyOn(document, 'addEventListener');
    removedFromDocument = vi.spyOn(document, 'removeEventListener');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const listensFor = (spy: ReturnType<typeof vi.spyOn>, type: string) => spy.mock.calls.filter((call: unknown[]) => call[0] === type).length;

  it('calls at once, and listens to nothing, when the cookie is already there', () => {
    cookie.present = true;
    const onCookie = vi.fn();

    const stop = whenBrowserSessionCookie(onCookie);

    expect(onCookie).toHaveBeenCalledTimes(1);
    expect(listensFor(added, 'focus')).toBe(0);
    expect(listensFor(addedToDocument, 'visibilitychange')).toBe(0);
    stop();
  });

  it('looks again as the tab takes the focus or is shown, calls once the cookie is there, and stops looking then', () => {
    const onCookie = vi.fn();
    whenBrowserSessionCookie(onCookie);
    expect(listensFor(added, 'focus')).toBe(1);
    expect(listensFor(addedToDocument, 'visibilitychange')).toBe(1);

    // Back in the tab, still no cookie: nothing.
    window.dispatchEvent(new Event('focus'));
    expect(onCookie).not.toHaveBeenCalled();

    // A sign-in in another tab wrote one: seen as this tab is shown again.
    cookie.present = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onCookie).toHaveBeenCalledTimes(1);
    expect(listensFor(removed, 'focus')).toBe(1);
    expect(listensFor(removedFromDocument, 'visibilitychange')).toBe(1);

    // Looking no more.
    window.dispatchEvent(new Event('focus'));
    expect(onCookie).toHaveBeenCalledTimes(1);
  });

  it('stops looking when told to', () => {
    const onCookie = vi.fn();
    const stop = whenBrowserSessionCookie(onCookie);

    stop();
    expect(listensFor(removed, 'focus')).toBe(1);
    expect(listensFor(removedFromDocument, 'visibilitychange')).toBe(1);
    cookie.present = true;
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));

    expect(onCookie).not.toHaveBeenCalled();
  });
});
