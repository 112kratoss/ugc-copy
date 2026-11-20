import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserSupabaseClient } from '@/lib/browser-session';
import {
  ACCOUNT_READ_KEPT_MS,
  OWN_PROFILE_COLUMNS,
  checkSessionUser,
  forgetAccountReads,
  readOwnProfile,
} from '@/lib/browser-account-reads';

type Answer<T> = { resolve: (value: T) => void; reject: (error: unknown) => void };

/** A Supabase client whose every check and read waits until the test answers it. */
function fakeSupabase() {
  const userChecks: Array<{ token: string } & Answer<unknown>> = [];
  const profileReads: Array<{ columns: string; id: unknown } & Answer<unknown>> = [];
  const later = <T,>(push: (answer: Answer<T>) => void) => new Promise<T>((resolve, reject) => {
    push({ resolve, reject });
  });
  const client = {
    auth: {
      getUser: vi.fn((token: string) => later((answer) => userChecks.push({ token, ...answer }))),
    },
    from: vi.fn(() => ({
      select: (columns: string) => ({
        eq: (_column: string, id: unknown) => ({
          maybeSingle: vi.fn(() => later((answer) => profileReads.push({ columns, id, ...answer }))),
        }),
      }),
    })),
  };
  return { client: client as unknown as BrowserSupabaseClient, raw: client, userChecks, profileReads };
}

const user = { id: 'user-1', email: 'creator@example.com' };
const row = { display_name: 'Creator', avatar_url: null, credits: 40, promotional_credits: 10, saver_notice_seen_at: null };

/** Lets every answer given so far reach its callers. */
const flush = () => new Promise((resolve) => {
  setTimeout(resolve, 0);
});

describe("the reader's session check, shared by everything on the page", () => {
  beforeEach(() => {
    forgetAccountReads();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks Supabase Auth once for every caller while the check is out, and gives each its answer', async () => {
    const supabase = fakeSupabase();
    const first = checkSessionUser(supabase.client, 'token-1');
    const second = checkSessionUser(supabase.client, 'token-1');
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(1);
    expect(supabase.raw.auth.getUser).toHaveBeenCalledWith('token-1');

    supabase.userChecks[0].resolve({ data: { user }, error: null });
    const expected = { user, failed: false, threw: false, error: null };
    await expect(first).resolves.toEqual(expected);
    await expect(second).resolves.toEqual(expected);
  });

  it('gives an answer to whoever asks about the same token soon after, and asks again after that', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const supabase = fakeSupabase();
    const first = checkSessionUser(supabase.client, 'token-1');
    supabase.userChecks[0].resolve({ data: { user }, error: null });
    await first;

    vi.advanceTimersByTime(ACCOUNT_READ_KEPT_MS - 1);
    await expect(checkSessionUser(supabase.client, 'token-1')).resolves.toMatchObject({ user, failed: false });
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(1);

    // Another token is another check.
    void checkSessionUser(supabase.client, 'token-2');
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(2);

    // Past the window, as a page opened later asked before: Supabase is asked again.
    vi.advanceTimersByTime(2);
    void checkSessionUser(supabase.client, 'token-1');
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(3);
  });

  // A request that hangs is not joined forever: the top bar's stuck check would otherwise answer a
  // comment composer opened minutes later (review of #889).
  it('lets nobody new join a check still out after the window: they ask on their own', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const supabase = fakeSupabase();
    const stuck = checkSessionUser(supabase.client, 'token-1');

    vi.advanceTimersByTime(ACCOUNT_READ_KEPT_MS - 1);
    const joined = checkSessionUser(supabase.client, 'token-1');
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    const own = checkSessionUser(supabase.client, 'token-1');
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(2);

    supabase.userChecks[1].resolve({ data: { user }, error: null });
    expect((await own).user).toBe(user);
    // The stuck check's late answer goes to those who asked for it, and is kept for nobody.
    const lateUser = { ...user };
    supabase.userChecks[0].resolve({ data: { user: lateUser }, error: null });
    expect((await stuck).user).toBe(lateUser);
    expect((await joined).user).toBe(lateUser);
    expect((await checkSessionUser(supabase.client, 'token-1')).user).toBe(user);
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(2);
  });

  it("goes by the browser's own clock, not the computer's, which can be set back", async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-11-20T08:00:00.000Z'));
    const supabase = fakeSupabase();
    const first = checkSessionUser(supabase.client, 'token-1');
    supabase.userChecks[0].resolve({ data: { user }, error: null });
    await first;

    // The window passes while the computer's clock is set back an hour.
    vi.advanceTimersByTime(ACCOUNT_READ_KEPT_MS);
    vi.setSystemTime(new Date('2026-11-20T07:00:00.000Z'));
    void checkSessionUser(supabase.client, 'token-1');
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(2);
  });

  // A page's provider asks with the moment it began: a page opened by a client navigation checks the
  // session itself, as it always did, while the top bar (which asks once per document) shares.
  it('gives a page only a check asked for since it began, and shares that one with everyone', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const supabase = fakeSupabase();
    const earlier = checkSessionUser(supabase.client, 'token-1');
    supabase.userChecks[0].resolve({ data: { user }, error: null });
    await earlier;

    vi.advanceTimersByTime(5);
    const pageBegan = performance.now();
    const pageCheck = checkSessionUser(supabase.client, 'token-1', { askedSince: pageBegan });
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(2);
    // Asked since the page began: the page's other parts, and the top bar, share it.
    const sameMoment = checkSessionUser(supabase.client, 'token-1', { askedSince: pageBegan });
    const topBar = checkSessionUser(supabase.client, 'token-1');
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(2);
    supabase.userChecks[1].resolve({ data: { user }, error: null });
    await expect(pageCheck).resolves.toMatchObject({ user });
    await expect(sameMoment).resolves.toMatchObject({ user });
    await expect(topBar).resolves.toMatchObject({ user });
  });

  it('asks again when told to, and that answer is the one shared from then on', async () => {
    const supabase = fakeSupabase();
    const first = checkSessionUser(supabase.client, 'token-1');
    supabase.userChecks[0].resolve({ data: { user }, error: null });
    await first;

    const renamed = { ...user, email: 'renamed@example.com' };
    const fresh = checkSessionUser(supabase.client, 'token-1', { fresh: true });
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(2);
    const joined = checkSessionUser(supabase.client, 'token-1');
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(2);
    supabase.userChecks[1].resolve({ data: { user: renamed }, error: null });
    await expect(fresh).resolves.toMatchObject({ user: renamed });
    await expect(joined).resolves.toMatchObject({ user: renamed });
  });

  it.each([
    ['an outage', { data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 0 } }],
    ['a refusal', { data: { user: null }, error: { name: 'AuthApiError', status: 403, code: 'session_not_found' } }],
    ['an answer naming nobody', { data: { user: null }, error: null }],
  ])('keeps no %s: the next caller asks again', async (_case, answer) => {
    const supabase = fakeSupabase();
    const first = checkSessionUser(supabase.client, 'token-1');
    const joined = checkSessionUser(supabase.client, 'token-1');
    supabase.userChecks[0].resolve(answer);
    const check = await first;
    expect(check.failed).toBe(answer.error !== null);
    expect(check.user).toBeNull();
    // Whoever asked while it was out shares it, as one caller's own check would have answered it.
    await expect(joined).resolves.toEqual(check);

    void checkSessionUser(supabase.client, 'token-1');
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(2);
  });

  it('answers a check that threw with its error, keeps none, and never rejects', async () => {
    const supabase = fakeSupabase();
    const first = checkSessionUser(supabase.client, 'token-1');
    const thrown = new TypeError('Cannot read properties of undefined');
    supabase.userChecks[0].reject(thrown);
    await expect(first).resolves.toEqual({ user: null, failed: true, threw: true, error: thrown });

    supabase.raw.auth.getUser.mockImplementationOnce(() => {
      throw thrown;
    });
    await expect(checkSessionUser(supabase.client, 'token-1')).resolves.toEqual({ user: null, failed: true, threw: true, error: thrown });
    void checkSessionUser(supabase.client, 'token-1');
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(3);
  });

  it('forgets every check at a sign-out: the same token is asked about again', async () => {
    const supabase = fakeSupabase();
    const first = checkSessionUser(supabase.client, 'token-1');
    supabase.userChecks[0].resolve({ data: { user }, error: null });
    await first;

    forgetAccountReads();
    void checkSessionUser(supabase.client, 'token-1');
    expect(supabase.raw.auth.getUser).toHaveBeenCalledTimes(2);
  });
});

describe("the reader's own profile row, shared by everything on the page", () => {
  beforeEach(() => {
    forgetAccountReads();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads every column any of them draws, once for every caller, in the caller’s own turn', async () => {
    const supabase = fakeSupabase();
    const first = readOwnProfile(supabase.client, 'user-1');
    // Asked at once, not a turn later: a caller that counts its reads as it asks sees this one.
    expect(supabase.profileReads).toHaveLength(1);
    expect(supabase.profileReads[0]).toMatchObject({ columns: OWN_PROFILE_COLUMNS, id: 'user-1' });
    expect(OWN_PROFILE_COLUMNS).toBe('display_name, avatar_url, credits, promotional_credits, saver_notice_seen_at');
    const second = readOwnProfile(supabase.client, 'user-1');
    expect(supabase.profileReads).toHaveLength(1);

    supabase.profileReads[0].resolve({ data: row, error: null });
    await expect(first).resolves.toEqual({ row, error: null });
    await expect(second).resolves.toEqual({ row, error: null });

    // Soon after, the answer is given again; another account is another read.
    await expect(readOwnProfile(supabase.client, 'user-1')).resolves.toEqual({ row, error: null });
    void readOwnProfile(supabase.client, 'user-2');
    expect(supabase.profileReads.map((read) => read.id)).toEqual(['user-1', 'user-2']);
  });

  it('reads again once the window has passed', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const supabase = fakeSupabase();
    const first = readOwnProfile(supabase.client, 'user-1');
    supabase.profileReads[0].resolve({ data: row, error: null });
    await first;

    vi.advanceTimersByTime(ACCOUNT_READ_KEPT_MS);
    void readOwnProfile(supabase.client, 'user-1');
    expect(supabase.profileReads).toHaveLength(2);
  });

  it('lets nobody new join a read still out after the window', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const supabase = fakeSupabase();
    void readOwnProfile(supabase.client, 'user-1');

    vi.advanceTimersByTime(ACCOUNT_READ_KEPT_MS - 1);
    void readOwnProfile(supabase.client, 'user-1');
    expect(supabase.profileReads).toHaveLength(1);

    vi.advanceTimersByTime(1);
    void readOwnProfile(supabase.client, 'user-1');
    expect(supabase.profileReads).toHaveLength(2);
  });

  // AuthProvider listens for the event from its mount, before anything is read: the count has to
  // move ahead of it, or a part of the page that reads again on the event without asking anew is
  // given the figure from before the change (review of #889).
  it('moves the count on a balance change ahead of the parts of the page that listen for it', async () => {
    vi.resetModules();
    const reads = await import('@/lib/browser-account-reads');
    const supabase = fakeSupabase();
    const rereadOnChange = () => {
      void reads.readOwnProfile(supabase.client, 'user-1');
    };
    window.addEventListener('credits_updated', rereadOnChange);
    try {
      const first = reads.readOwnProfile(supabase.client, 'user-1');
      supabase.profileReads[0].resolve({ data: row, error: null });
      await first;

      window.dispatchEvent(new Event('credits_updated'));
      expect(supabase.profileReads).toHaveLength(2);
    } finally {
      window.removeEventListener('credits_updated', rereadOnChange);
    }
  });

  it('gives nobody who asks after the balance moved a figure read before it, even one still out', async () => {
    const supabase = fakeSupabase();
    const before = readOwnProfile(supabase.client, 'user-1');
    window.dispatchEvent(new Event('credits_updated'));

    const after = readOwnProfile(supabase.client, 'user-1');
    expect(supabase.profileReads).toHaveLength(2);
    const spent = { ...row, credits: 25 };
    supabase.profileReads[0].resolve({ data: row, error: null });
    supabase.profileReads[1].resolve({ data: spent, error: null });
    await expect(before).resolves.toEqual({ row, error: null });
    await expect(after).resolves.toEqual({ row: spent, error: null });

    // The read made after the change is the one shared from then on.
    await expect(readOwnProfile(supabase.client, 'user-1')).resolves.toEqual({ row: spent, error: null });
    expect(supabase.profileReads).toHaveLength(2);

    // A balance announced with its figure moves it too.
    window.dispatchEvent(new CustomEvent('credits_updated', { detail: { credits: 5 } }));
    void readOwnProfile(supabase.client, 'user-1');
    expect(supabase.profileReads).toHaveLength(3);
  });

  it('gives a page only a read asked for since it began', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const supabase = fakeSupabase();
    const earlier = readOwnProfile(supabase.client, 'user-1');
    supabase.profileReads[0].resolve({ data: row, error: null });
    await earlier;

    vi.advanceTimersByTime(5);
    const pageBegan = performance.now();
    void readOwnProfile(supabase.client, 'user-1', { askedSince: pageBegan });
    expect(supabase.profileReads).toHaveLength(2);
    // The comment composer, which reads once for the document, takes the page's.
    void readOwnProfile(supabase.client, 'user-1');
    void readOwnProfile(supabase.client, 'user-1', { askedSince: pageBegan });
    expect(supabase.profileReads).toHaveLength(2);
  });

  it('reads again when told to, and that read is the one shared from then on', async () => {
    const supabase = fakeSupabase();
    const first = readOwnProfile(supabase.client, 'user-1');
    supabase.profileReads[0].resolve({ data: row, error: null });
    await first;

    const fresh = readOwnProfile(supabase.client, 'user-1', { fresh: true });
    expect(supabase.profileReads).toHaveLength(2);
    const joined = readOwnProfile(supabase.client, 'user-1');
    expect(supabase.profileReads).toHaveLength(2);
    const topped = { ...row, credits: 140 };
    supabase.profileReads[1].resolve({ data: topped, error: null });
    await expect(fresh).resolves.toEqual({ row: topped, error: null });
    await expect(joined).resolves.toEqual({ row: topped, error: null });
  });

  it.each([
    ['a failed read', { data: null, error: { message: 'TypeError: Failed to fetch' } }],
    ['no row for the account', { data: null, error: null }],
  ])('keeps %s: the next caller reads again', async (_case, answer) => {
    const supabase = fakeSupabase();
    const first = readOwnProfile(supabase.client, 'user-1');
    supabase.profileReads[0].resolve(answer);
    await expect(first).resolves.toEqual({ row: null, error: answer.error });
    await flush();

    void readOwnProfile(supabase.client, 'user-1');
    expect(supabase.profileReads).toHaveLength(2);
  });

  it('answers a read that rejected or threw with its error, and never rejects', async () => {
    const supabase = fakeSupabase();
    const first = readOwnProfile(supabase.client, 'user-1');
    const offline = new Error('offline');
    supabase.profileReads[0].reject(offline);
    await expect(first).resolves.toEqual({ row: null, error: offline });

    supabase.raw.from.mockImplementationOnce(() => {
      throw offline;
    });
    await expect(readOwnProfile(supabase.client, 'user-1')).resolves.toEqual({ row: null, error: offline });
  });

  it('forgets every read at a sign-out: the same account is read again', async () => {
    const supabase = fakeSupabase();
    const first = readOwnProfile(supabase.client, 'user-1');
    supabase.profileReads[0].resolve({ data: row, error: null });
    await first;

    forgetAccountReads();
    void readOwnProfile(supabase.client, 'user-1');
    expect(supabase.profileReads).toHaveLength(2);
  });
});
