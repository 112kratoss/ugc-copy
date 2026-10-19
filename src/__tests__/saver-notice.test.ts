import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dismissToast,
  readFeedbackSnapshot,
  resetFeedbackState,
  subscribeToFeedback,
} from '@/components/feedback-state';
import {
  SAVER_NOTICE_MESSAGE,
  creatorSeesSaverFields,
  resetSaverNoticeForTests,
  syncSaverNotice,
} from '@/components/saver-notice';

function notices() {
  return readFeedbackSnapshot().toasts.filter((toast) => toast.message === SAVER_NOTICE_MESSAGE);
}

/** Lets the notice module's own requests settle. */
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('saver notice', () => {
  let unsubscribe = () => {};
  let fetchMock: ReturnType<typeof vi.fn>;
  let serverSeen = false;

  beforeEach(() => {
    // The root layout's FeedbackViewport, which draws every toast.
    unsubscribe = subscribeToFeedback(() => {});
    serverSeen = false;
    fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') serverSeen = true;
      return { ok: true, json: async () => ({ seen: serverSeen }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    unsubscribe();
    resetFeedbackState();
    resetSaverNoticeForTests();
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("tells an account at its first save, keeps the creator out of its saves until the notice goes, then names it", async () => {
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ saverNotYetTold: true });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ tone: 'info', durationMs: 6000 });

    // A save while the notice is still up was not made after it.
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ saverNotYetTold: true });
    expect(notices()).toHaveLength(1);

    dismissToast(notices()[0].id, 'closed');
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ creatorSeesSaver: true });
    expect(window.localStorage.getItem('magicbooklet:saver-notice:v1:user-1')).toBe('1');

    // And on record, for the account's other devices and for the server's check.
    await settle();
    expect(fetchMock).toHaveBeenCalledWith('/api/profile/saver-notice', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-1' },
    });

    // A later page load in the same browser has been told already.
    resetSaverNoticeForTests();
    resetFeedbackState();
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ creatorSeesSaver: true });
    expect(notices()).toHaveLength(0);
  });

  it('counts a notice that ran out on a page in view, and not one that ran out out of view', () => {
    creatorSeesSaverFields('user-1', true, 'token-1');
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    dismissToast(notices()[0].id, 'expired');
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ saverNotYetTold: true });
    expect(notices()).toHaveLength(1);

    visibility.mockReturnValue('visible');
    dismissToast(notices()[0].id, 'expired');
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ creatorSeesSaver: true });
  });

  it('tells each account on a shared browser for itself', () => {
    creatorSeesSaverFields('user-1', true, 'token-1');
    dismissToast(notices()[0].id, 'closed');
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ creatorSeesSaver: true });

    // Someone else signs in, with or without a reload: they have not been told.
    expect(creatorSeesSaverFields('user-2', true, 'token-2')).toEqual({ saverNotYetTold: true });
    expect(notices()).toHaveLength(1);
  });

  it('adds nothing to taking a save back, or to a save with no account, and says nothing', () => {
    expect(creatorSeesSaverFields('user-1', false, 'token-1')).toEqual({});
    expect(creatorSeesSaverFields(null, true, 'token-1')).toEqual({});
    expect(notices()).toHaveLength(0);
  });

  it('still tells a browser that refuses storage, once a page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ saverNotYetTold: true });
    dismissToast(notices()[0].id, 'closed');
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ creatorSeesSaver: true });
  });

  it('keeps the creator out of saves, and the account untold, while nothing on the page could show the notice', () => {
    unsubscribe();

    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ saverNotYetTold: true });
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ saverNotYetTold: true });
    expect(notices()).toHaveLength(0);
    expect(window.localStorage.length).toBe(0);
  });

  it('takes a telling on record from another device, without the notice', async () => {
    serverSeen = true;
    syncSaverNotice('user-1', 'token-1');
    await settle();

    expect(fetchMock).toHaveBeenCalledWith('/api/profile/saver-notice', { headers: { Authorization: 'Bearer token-1' } });
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ creatorSeesSaver: true });
    expect(notices()).toHaveLength(0);
  });

  it('records a telling this browser holds that the server missed, and reads the record once a page', async () => {
    window.localStorage.setItem('magicbooklet:saver-notice:v1:user-1', '1');

    syncSaverNotice('user-1', 'token-1');
    syncSaverNotice('user-1', 'token-1');
    await settle();

    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? 'GET')).toEqual(['GET', 'POST']);
  });
});

describe('who may set creatorSeesSaver and saverNotYetTold', () => {
  // The server takes the fields as word of what the person was told, so the
  // web sets them only through the notice module; the save route reads them
  // and the save service acts on them. A shorthand property or a quoted key
  // counts as much as a written-out one; comments do not.
  it('is written only by the notice module and read only by the save route and service', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const sourceFiles = (root: string): string[] => readdirSync(root).flatMap((entry) => {
      const absolutePath = path.join(root, entry);
      if (statSync(absolutePath).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(absolutePath);
      return /\.(ts|tsx)$/.test(entry) ? [absolutePath] : [];
    });
    const withoutComments = (source: string) => source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    const mentioning = sourceFiles(srcRoot)
      .filter((filePath) => /\b(creatorSeesSaver|saverNotYetTold)\b/.test(withoutComments(readFileSync(filePath, 'utf8'))))
      .map((filePath) => path.relative(srcRoot, filePath).replaceAll(path.sep, '/'))
      .sort();

    expect(mentioning).toEqual([
      'components/saver-notice.ts',
      'lib/showcase-save-route-adapter-service.ts',
      'lib/showcase-save-service.ts',
    ]);
  });
});
