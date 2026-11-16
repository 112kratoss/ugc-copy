import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RELOAD_OPENS_AT_TOP } from '@/lib/reload-opens-at-top';

// A refresh of Home opened at the old offset on a feed ranked afresh (owner's recording,
// 2026-11-16); Explore and Marketplace start afresh on a reload too. The inline script marks
// those pages' history entry `manual` as the document goes, and the next document gives `auto`
// back: after a reload's load, at once after a Back or Forward from another document. These are
// its rules; the browser's half (the restore itself, Back after a reload) is
// tests/e2e/reload-opens-at-top.spec.ts.

// jsdom has no `history.scrollRestoration`: an own property stands in for it, as the script
// reads and writes it.
let mode: 'auto' | 'manual' = 'auto';
let readyState: DocumentReadyState = 'complete';
let navigationType: string = 'navigate';
const listeners: Array<[string, EventListenerOrEventListenerObject]> = [];
const addEventListener = window.addEventListener.bind(window);

beforeEach(() => {
  mode = 'auto';
  readyState = 'complete';
  navigationType = 'navigate';
  Object.defineProperty(window.history, 'scrollRestoration', {
    configurable: true,
    get: () => mode,
    set: (value: 'auto' | 'manual') => {
      mode = value;
    },
  });
  vi.spyOn(document, 'readyState', 'get').mockImplementation(() => readyState);
  vi.spyOn(performance, 'getEntriesByType').mockImplementation((entryType: string) => (
    entryType === 'navigation' ? [{ type: navigationType } as unknown as PerformanceEntry] : []
  ));
  // Each test's script adds its listeners; take them off again after it.
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    listeners.push([type, listener]);
    addEventListener(type, listener, options);
  });
  // Timers only: faking `performance` too would replace the navigation entry spied on above.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  for (const [type, listener] of listeners.splice(0)) window.removeEventListener(type, listener);
  delete (window.history as { scrollRestoration?: unknown }).scrollRestoration;
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function runAt(address: string) {
  window.history.replaceState(null, '', address);
  new Function(RELOAD_OPENS_AT_TOP)();
}

function pagehide() {
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
}

/** A document whose entry came in marked by the page that left it. */
function comesInMarked(type: 'reload' | 'back_forward', address = '/') {
  mode = 'manual';
  navigationType = type;
  readyState = 'loading';
  runAt(address);
}

function finishLoad() {
  readyState = 'complete';
  window.dispatchEvent(new Event('load'));
}

describe('leaving a document', () => {
  it.each([
    '/',
    '/?chip=recent',
    '/#top',
    '/showcase',
    '/showcase?category=video&sort=recent',
    '/showcase?post=p1',
    '/marketplace',
    '/marketplace?sort=top-sales&kind=prompt',
  ])('on a page drawn afresh by a reload (%s) marks the entry for no restore', (address) => {
    runAt('/creators/someone');
    window.history.replaceState(null, '', address);

    pagehide();

    expect(mode).toBe('manual');
  });

  it.each([
    '/showcase/p1',
    '/marketplace/asset-1',
    '/marketplace/sell',
    '/creators/someone',
    '/profile',
    '/search?q=cats',
    '/notifications',
    '/home',
  ])('on another page (%s) leaves the restore alone', (address) => {
    runAt('/');
    window.history.replaceState(null, '', address);

    pagehide();

    expect(mode).toBe('auto');
  });
});

describe('a reloaded document that comes in with the restore off', () => {
  it('gives it back only after its load is done', () => {
    comesInMarked('reload');

    vi.runAllTimers();
    expect(mode).toBe('manual');

    finishLoad();
    // Not inside the load event itself: the browser's own last restore comes after it.
    expect(mode).toBe('manual');
    vi.runAllTimers();
    expect(mode).toBe('auto');
  });

  it('already loaded when the script runs, gives it back on the next task', () => {
    mode = 'manual';
    navigationType = 'reload';
    runAt('/showcase');

    expect(mode).toBe('manual');
    vi.runAllTimers();
    expect(mode).toBe('auto');
  });

  it.each(['navigate', 'prerender'])('after a %s load waits for the load too', (type) => {
    mode = 'manual';
    navigationType = type;
    readyState = 'loading';
    runAt('/');

    expect(mode).toBe('manual');
    finishLoad();
    vi.runAllTimers();
    expect(mode).toBe('auto');
  });
});

describe('a document reached by Back or Forward from another document', () => {
  it.each(['/', '/showcase', '/marketplace'])('on %s gives the restore back at once, so the reader is put back', (address) => {
    comesInMarked('back_forward', address);

    expect(mode).toBe('auto');
  });
});

describe('a reload that no pagehide came before (a tab the browser discarded)', () => {
  it.each(['/', '/showcase?category=video', '/marketplace'])('on %s turns the restore off itself until its load is done', (address) => {
    readyState = 'loading';
    navigationType = 'reload';
    runAt(address);

    expect(mode).toBe('manual');
    finishLoad();
    vi.runAllTimers();
    expect(mode).toBe('auto');
  });

  it.each(['/showcase/p1', '/creators/someone', '/marketplace/sell'])('on another page (%s) leaves it on', (address) => {
    readyState = 'loading';
    navigationType = 'reload';
    runAt(address);

    expect(mode).toBe('auto');
  });
});

it.each(['navigate', 'back_forward'])('a %s load that came in with the restore on leaves it on', (type) => {
  readyState = 'loading';
  navigationType = type;
  runAt('/');

  expect(mode).toBe('auto');
  finishLoad();
  vi.runAllTimers();
  expect(mode).toBe('auto');
});

describe('an entry still marked when it is reached again', () => {
  it('by Back or Forward inside the app after the load gets the restore back', () => {
    runAt('/');
    // Pushed while the reload was still loading: the entry took `manual` with it.
    mode = 'manual';

    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(mode).toBe('auto');
  });

  it('by Back or Forward inside the app before the load ends keeps it off', () => {
    readyState = 'loading';
    runAt('/');
    mode = 'manual';

    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(mode).toBe('manual');
  });

  it('from the back-forward cache gets it back at once', () => {
    runAt('/');
    pagehide();
    expect(mode).toBe('manual');

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));

    expect(mode).toBe('auto');
  });

  it('on a first show of a reload, not from the cache, waits for the load', () => {
    comesInMarked('reload');

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));

    expect(mode).toBe('manual');
  });
});

it('runs from the root layout, on every full load', () => {
  const layout = readFileSync(path.join(process.cwd(), 'src/app/layout.tsx'), 'utf8');

  expect(layout).toContain('<script dangerouslySetInnerHTML={{ __html: RELOAD_OPENS_AT_TOP }} />');
});

it('does nothing where the browser has no scrollRestoration', () => {
  delete (window.history as { scrollRestoration?: unknown }).scrollRestoration;

  expect(() => runAt('/')).not.toThrow();
  pagehide();
  expect('scrollRestoration' in window.history).toBe(false);
});
