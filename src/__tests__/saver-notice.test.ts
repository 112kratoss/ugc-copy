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

/** What this browser keeps of an account: told and on record, told and not yet, or nothing. */
function remembered(accountId: string) {
  return window.localStorage.getItem(`magicbooklet:saver-notice:v2:${accountId}`);
}

function remember(accountId: string, memory: 'pending' | 'recorded') {
  window.localStorage.setItem(`magicbooklet:saver-notice:v2:${accountId}`, memory);
}

/** Lets the notice module's own requests settle. */
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('saver notice', () => {
  let unsubscribe = () => {};
  let fetchMock: ReturnType<typeof vi.fn>;
  let serverSeen = false;

  /** The requests made to the record, by method, in order. */
  const recordRequests = () => fetchMock.mock.calls
    .filter(([input]) => String(input) === '/api/profile/saver-notice')
    .map(([, init]) => (init as RequestInit | undefined)?.method ?? 'GET');

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
    expect(notices()[0]).toMatchObject({ tone: 'info', durationMs: 6000, closeGuardMs: 700 });

    // A save while the notice is still up was not made after it.
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ saverNotYetTold: true });
    expect(notices()).toHaveLength(1);

    dismissToast(notices()[0].id, 'closed');
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ creatorSeesSaver: true });
    // Told here at once; on record once the server has it.
    expect(remembered('user-1')).toBe('pending');

    // And on record, for the account's other devices and for the server's check.
    await settle();
    expect(fetchMock).toHaveBeenCalledWith('/api/profile/saver-notice', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-1' },
    });
    expect(remembered('user-1')).toBe('recorded');

    // A later page load in the same browser has been told already.
    resetSaverNoticeForTests();
    resetFeedbackState();
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ creatorSeesSaver: true });
    expect(notices()).toHaveLength(0);
  });

  it('counts a notice that ran out on a page in view, and not one that ran out out of view or was taken down', () => {
    creatorSeesSaverFields('user-1', true, 'token-1');
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    dismissToast(notices()[0].id, 'expired');
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ saverNotYetTold: true });
    expect(notices()).toHaveLength(1);

    visibility.mockReturnValue('visible');
    dismissToast(notices()[0].id, 'interrupted');
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ saverNotYetTold: true });
    expect(remembered('user-1')).toBeNull();

    dismissToast(notices()[0].id, 'expired');
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ creatorSeesSaver: true });
    expect(remembered('user-1')).toBe('pending');
  });

  it('tells each account on a shared browser for itself', () => {
    creatorSeesSaverFields('user-1', true, 'token-1');
    dismissToast(notices()[0].id, 'closed');
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ creatorSeesSaver: true });

    // Someone else signs in, with or without a reload: they have not been told.
    expect(creatorSeesSaverFields('user-2', true, 'token-2')).toEqual({ saverNotYetTold: true });
    expect(notices()).toHaveLength(1);
  });

  it.each([
    { how: 'another account signs in', next: 'user-2' },
    { how: 'the account signs out', next: null },
  ])("takes the notice down unread when $how, recording a telling for no one", async ({ next }) => {
    syncSaverNotice('user-1', 'token-1', false);
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ saverNotYetTold: true });
    expect(notices()).toHaveLength(1);

    syncSaverNotice(next, next ? 'token-2' : null, next ? false : null);
    expect(notices()).toHaveLength(0);
    await settle();

    expect(recordRequests()).toEqual([]);
    expect(window.localStorage.length).toBe(0);
    if (next) {
      expect(creatorSeesSaverFields(next, true, 'token-2')).toEqual({ saverNotYetTold: true });
      // The second account's own notice, not a telling carried over.
      expect(notices()).toHaveLength(1);
    }

    // The first account was not told either: back on this page, it is told at its next save.
    syncSaverNotice('user-1', 'token-1', false);
    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ saverNotYetTold: true });
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

  it('ignores what the first version of the notice kept', () => {
    // Kept before the server's record decided; a v1 telling may never have reached it.
    window.localStorage.setItem('magicbooklet:saver-notice:v1:user-1', '1');

    expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ saverNotYetTold: true });
    expect(notices()).toHaveLength(1);
  });

  describe("the account's record, read with the page or asked for", () => {
    it.each([true, false])('takes the record the page was drawn with (%s), and asks the server nothing', async (seen) => {
      syncSaverNotice('user-1', 'token-1', seen);
      await settle();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(creatorSeesSaverFields('user-1', true, 'token-1'))
        .toEqual(seen ? { creatorSeesSaver: true } : { saverNotYetTold: true });
      expect(notices()).toHaveLength(seen ? 0 : 1);
      expect(remembered('user-1')).toBe(seen ? 'recorded' : null);
    });

    // The page hands out the record it was drawn with for its whole life, and
    // the save surfaces sync again at every token refresh and every mount.
    it('takes the record the page was drawn with in once, so a telling recorded on the page outlives the syncs after it', async () => {
      syncSaverNotice('user-1', 'token-1', false);
      expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ saverNotYetTold: true });
      dismissToast(notices()[0].id, 'closed');
      await settle();
      expect(remembered('user-1')).toBe('recorded');

      // A token refresh, then another save surface mounting.
      syncSaverNotice('user-1', 'token-2', false);
      syncSaverNotice('user-1', 'token-2', false);
      await settle();

      expect(remembered('user-1')).toBe('recorded');
      expect(creatorSeesSaverFields('user-1', true, 'token-2')).toEqual({ creatorSeesSaver: true });
      expect(notices()).toHaveLength(0);
      expect(recordRequests()).toEqual(['POST']);
    });

    it('takes a telling on record from another device, without the notice', async () => {
      serverSeen = true;
      syncSaverNotice('user-1', 'token-1');
      await settle();

      expect(fetchMock).toHaveBeenCalledWith('/api/profile/saver-notice', { headers: { Authorization: 'Bearer token-1' } });
      expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ creatorSeesSaver: true });
      expect(notices()).toHaveLength(0);
      expect(remembered('user-1')).toBe('recorded');
    });

    it('asks for the record once a page when the page could not know it, and again after an ask that failed', async () => {
      fetchMock.mockImplementationOnce(async () => {
        throw new TypeError('Failed to fetch');
      });

      syncSaverNotice('user-1', 'token-1', null);
      await settle();
      syncSaverNotice('user-1', 'token-1', null);
      await settle();
      syncSaverNotice('user-1', 'token-1');
      syncSaverNotice('user-1', 'token-1', undefined);
      await settle();

      expect(recordRequests()).toEqual(['GET', 'GET']);
      // With no token there is nothing to ask with.
      syncSaverNotice('user-2', null, null);
      await settle();
      expect(recordRequests()).toEqual(['GET', 'GET']);
    });

    it('records a telling this browser holds that the server missed, and reads the record once a page', async () => {
      remember('user-1', 'pending');

      syncSaverNotice('user-1', 'token-1');
      syncSaverNotice('user-1', 'token-1');
      await settle();

      expect([...recordRequests()].sort()).toEqual(['GET', 'POST']);
      expect(remembered('user-1')).toBe('recorded');
    });

    it.each([
      { from: 'the page it was drawn with', seen: false as boolean | undefined },
      { from: 'the server, asked', seen: undefined },
    ])('tells an account again when $from says no telling is on record that this browser saw recorded', async ({ seen }) => {
      // Cleared there on purpose: the server's record decides.
      remember('user-1', 'recorded');

      syncSaverNotice('user-1', 'token-1', seen);
      await settle();

      expect(remembered('user-1')).toBeNull();
      expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ saverNotYetTold: true });
      expect(notices()).toHaveLength(1);
      expect(recordRequests()).toEqual(seen === undefined ? ['GET'] : []);
    });

    it('records a telling not yet on record when the page says the server has none, without telling them again', async () => {
      remember('user-1', 'pending');

      syncSaverNotice('user-1', 'token-1', false);
      await settle();

      expect(recordRequests()).toEqual(['POST']);
      expect(remembered('user-1')).toBe('recorded');
      expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ creatorSeesSaver: true });
      expect(notices()).toHaveLength(0);
    });

    it("asks again for a telling once the server's answer says it has none, after a record that was refused", async () => {
      remember('user-1', 'pending');
      let records = 0;
      let answerRead: (seen: boolean) => void = () => {};
      fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          // The first record is refused; the next one is taken.
          records += 1;
          return { ok: records > 1, json: async () => ({}) } as Response;
        }
        const seen = await new Promise<boolean>((resolve) => {
          answerRead = resolve;
        });
        return { ok: true, json: async () => ({ seen }) } as Response;
      });

      syncSaverNotice('user-1', 'token-1');
      await settle();
      // What this browser holds went out at once, and was refused.
      expect(recordRequests().filter((method) => method === 'POST')).toHaveLength(1);
      expect(remembered('user-1')).toBe('pending');

      answerRead(false);
      await settle();

      expect(recordRequests().filter((method) => method === 'POST')).toHaveLength(2);
      expect(recordRequests().filter((method) => method === 'GET')).toHaveLength(1);
      expect(remembered('user-1')).toBe('recorded');
      expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ creatorSeesSaver: true });
      expect(notices()).toHaveLength(0);
    });

    it('asks the server again at the next save for a telling it has not yet taken on record', async () => {
      // The first record is refused.
      fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response);
      creatorSeesSaverFields('user-1', true, 'token-1');
      dismissToast(notices()[0].id, 'closed');
      await settle();

      expect(recordRequests()).toEqual(['POST']);
      expect(remembered('user-1')).toBe('pending');

      // Told all the same: the save names them, and the record is asked for again.
      expect(creatorSeesSaverFields('user-1', true, 'token-1')).toEqual({ creatorSeesSaver: true });
      await settle();
      expect(recordRequests()).toEqual(['POST', 'POST']);
      expect(remembered('user-1')).toBe('recorded');

      // On record, a save asks nothing more.
      creatorSeesSaverFields('user-1', true, 'token-1');
      await settle();
      expect(recordRequests()).toEqual(['POST', 'POST']);
    });
  });
});

describe('who may set creatorSeesSaver and saverNotYetTold', () => {
  // The server takes the fields as word of what the person was told, so they
  // are set only by the notice policy the web shares with the app; the save
  // route reads them and the save service acts on them. A shorthand property
  // or a quoted key counts as much as a written-out one; comments do not.
  const srcRoot = path.resolve(__dirname, '..');
  const withoutComments = (source: string) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const mentionsTheFields = (source: string) => /\b(creatorSeesSaver|saverNotYetTold)\b/.test(withoutComments(source));

  it('is written only by the shared notice policy and read only by the save route and service', () => {
    const sourceFiles = (root: string): string[] => readdirSync(root).flatMap((entry) => {
      const absolutePath = path.join(root, entry);
      if (statSync(absolutePath).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(absolutePath);
      return /\.(ts|tsx)$/.test(entry) ? [absolutePath] : [];
    });

    const mentioning = sourceFiles(srcRoot)
      .filter((filePath) => mentionsTheFields(readFileSync(filePath, 'utf8')))
      .map((filePath) => path.relative(srcRoot, filePath).replaceAll(path.sep, '/'))
      .sort();

    expect(mentioning).toEqual([
      'lib/showcase-save-route-adapter-service.ts',
      'lib/showcase-save-service.ts',
    ]);

    // The web's notice takes them from the policy, and writes none itself.
    const policy = readFileSync(path.resolve(srcRoot, '../ugc-mobile/lib/saver-notice-policy/saver-notice-policy.ts'), 'utf8');
    expect(mentionsTheFields(policy)).toBe(true);
    const webNotice = readFileSync(path.join(srcRoot, 'components/saver-notice.ts'), 'utf8');
    expect(webNotice).toContain("from '../../ugc-mobile/lib/saver-notice-policy/saver-notice-policy'");
    expect(webNotice).toContain('policy.fieldsForSave(');
  });
});
