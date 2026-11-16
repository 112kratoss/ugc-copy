import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOME_RELOAD_AT_TOP } from '@/lib/home-reload-at-top';

// A refresh of Home opened at the old offset on a feed ranked afresh (owner's recording,
// 2026-11-16). The inline script marks Home's history entry `manual` as the document goes and
// gives `auto` back once the next document's load is done. These are its rules; the browser's
// half (the restore itself, Back inside the app after a reload) is
// tests/e2e/home-reload-opens-at-top.spec.ts.

// jsdom has no `history.scrollRestoration`: an own property stands in for it, as the script
// reads and writes it.
let mode: 'auto' | 'manual' = 'auto';
let readyState: DocumentReadyState = 'complete';
const listeners: Array<[string, EventListenerOrEventListenerObject]> = [];
const addEventListener = window.addEventListener.bind(window);

beforeEach(() => {
  mode = 'auto';
  readyState = 'complete';
  Object.defineProperty(window.history, 'scrollRestoration', {
    configurable: true,
    get: () => mode,
    set: (value: 'auto' | 'manual') => {
      mode = value;
    },
  });
  vi.spyOn(document, 'readyState', 'get').mockImplementation(() => readyState);
  // Each test's script adds its listeners; take them off again after it.
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    listeners.push([type, listener]);
    addEventListener(type, listener, options);
  });
  vi.useFakeTimers();
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
  new Function(HOME_RELOAD_AT_TOP)();
}

function pagehide() {
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
}

describe('leaving a document', () => {
  it.each(['/', '/?chip=recent', '/#top'])('on Home (%s) marks the entry for no restore', (address) => {
    runAt('/showcase');
    window.history.replaceState(null, '', address);

    pagehide();

    expect(mode).toBe('manual');
  });

  it.each(['/showcase', '/showcase?post=p1', '/creators/someone', '/search?q=cats', '/home'])(
    'on another page (%s) leaves the restore alone',
    (address) => {
      runAt('/');
      window.history.replaceState(null, '', address);

      pagehide();

      expect(mode).toBe('auto');
    },
  );
});

describe('a document that comes in with the restore off', () => {
  it('gives it back only after its load is done', () => {
    mode = 'manual';
    readyState = 'loading';
    runAt('/');

    vi.runAllTimers();
    expect(mode).toBe('manual');

    readyState = 'complete';
    window.dispatchEvent(new Event('load'));
    // Not inside the load event itself, where the browser's own last restore comes after it.
    expect(mode).toBe('manual');
    vi.runAllTimers();
    expect(mode).toBe('auto');
  });

  it('already loaded when the script runs, gives it back on the next task', () => {
    mode = 'manual';
    runAt('/showcase');

    expect(mode).toBe('manual');
    vi.runAllTimers();
    expect(mode).toBe('auto');
  });

  it('that came in with the restore on leaves it on', () => {
    readyState = 'loading';
    runAt('/');
    readyState = 'complete';
    window.dispatchEvent(new Event('load'));
    vi.runAllTimers();

    expect(mode).toBe('auto');
  });
});

describe('an entry still marked when it is reached again', () => {
  it('by Back or Forward after the load gets the restore back', () => {
    runAt('/');
    // Pushed while the reload was still loading: the entry took `manual` with it.
    mode = 'manual';

    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(mode).toBe('auto');
  });

  it('by Back or Forward before the load ends keeps it off', () => {
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

  it('on a first show, not from the cache, waits for the load', () => {
    readyState = 'loading';
    mode = 'manual';
    runAt('/');

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));

    expect(mode).toBe('manual');
  });
});

it('runs from the root layout, on every full load', () => {
  const layout = readFileSync(path.join(process.cwd(), 'src/app/layout.tsx'), 'utf8');

  expect(layout).toContain('<script dangerouslySetInnerHTML={{ __html: HOME_RELOAD_AT_TOP }} />');
});

it('does nothing where the browser has no scrollRestoration', () => {
  delete (window.history as { scrollRestoration?: unknown }).scrollRestoration;

  expect(() => runAt('/')).not.toThrow();
  pagehide();
  expect('scrollRestoration' in window.history).toBe(false);
});
