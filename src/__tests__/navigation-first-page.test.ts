import { afterEach, describe, expect, it, vi } from 'vitest';

// The post page's way back is drawn only on a page reached inside the document:
// never on the page it was loaded at (a shared link, a refresh, a new tab, or a
// return to it by the browser's Back), whatever navigation brought the viewer
// anywhere else (a link, a router push or replace).

async function loadDocumentAt(pathname: string | null) {
  vi.resetModules();
  if (pathname === null) {
    vi.stubGlobal('window', undefined);
  } else {
    window.history.replaceState(null, '', pathname);
  }
  return import('@/components/navigation-progress-state');
}

describe('isPageReachedInThisDocument', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('is false for the page the document was loaded at, and true for every other page', async () => {
    const { isPageReachedInThisDocument } = await loadDocumentAt('/showcase/post-1');
    // The address moves on with each client navigation; the first page stays the first.
    window.history.replaceState(null, '', '/search?q=rooftop');

    expect(isPageReachedInThisDocument('/showcase/post-1')).toBe(false);
    expect(isPageReachedInThisDocument('/search')).toBe(true);
    expect(isPageReachedInThisDocument('/showcase/post-2')).toBe(true);
  });

  it('is false on the server, so the server render and the first page hydrating agree', async () => {
    const { isPageReachedInThisDocument } = await loadDocumentAt(null);

    expect(isPageReachedInThisDocument('/showcase/post-1')).toBe(false);
  });
});
