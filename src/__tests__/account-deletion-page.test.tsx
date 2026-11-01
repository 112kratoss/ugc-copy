import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Activity } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeleteAccountPage from '@/app/delete-account/page';
import { wasSignedOutInBrowser } from '@/lib/browser-sign-out';
import { unsignedJwt } from '@/__tests__/fixtures/unsigned-jwt';
import { siteConfig } from '@/lib/seo';

type TestUser = {
    id: string;
    email?: string;
    app_metadata: { provider?: string; providers?: string[] };
    identities: Array<{ provider: string }>;
};
type TestSession = { access_token: string; user: TestUser } | null;

const mocks = vi.hoisted(() => ({
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() },
    session: null as null | { access_token: string; user: unknown },
    listeners: new Set<(event: string, session: unknown) => void>(),
    signOut: vi.fn(),
    signInWithPassword: vi.fn(),
    getUser: vi.fn(),
    clearPersistedCreatorData: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
vi.mock('@/lib/supabase', () => ({
    supabase: {
        auth: {
            getSession: async () => ({ data: { session: mocks.session } }),
            // As auth-js does: the current session is reported once, just after subscribing.
            onAuthStateChange: (listener: (event: string, session: unknown) => void) => {
                mocks.listeners.add(listener);
                queueMicrotask(() => {
                    if (mocks.listeners.has(listener)) listener('INITIAL_SESSION', mocks.session);
                });
                return { data: { subscription: { unsubscribe: () => mocks.listeners.delete(listener) } } };
            },
            signOut: mocks.signOut,
            signInWithPassword: mocks.signInWithPassword,
            getUser: mocks.getUser,
        },
    },
}));
vi.mock('@/lib/persisted-media', () => ({
    clearPersistedCreatorData: mocks.clearPersistedCreatorData,
}));

const emailUser: TestUser = {
    id: 'user-email',
    email: 'creator@example.com',
    app_metadata: { provider: 'email', providers: ['email'] },
    identities: [{ provider: 'email' }],
};
const googleUser: TestUser = {
    id: 'user-google',
    email: 'google-creator@example.com',
    app_metadata: { provider: 'google', providers: ['google'] },
    identities: [{ provider: 'google' }],
};
const appleUser: TestUser = {
    id: 'user-apple',
    email: 'relay@privaterelay.appleid.com',
    app_metadata: { provider: 'apple', providers: ['apple'] },
    identities: [{ provider: 'apple' }],
};
const PASSWORD = 'correct-Horse-7!';
const SUPABASE_URL = 'https://project-ref.supabase.co';
const AUTH_COOKIE = 'sb-project-ref-auth-token';

/** What auth-js returns when Supabase Auth cannot be reached. */
const unreachable = Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 });
/** What auth-js makes of Supabase's session_not_found. */
const sessionMissing = Object.assign(new Error('Auth session missing!'), { name: 'AuthSessionMissingError', status: 400 });

function clearCookies() {
    for (const part of document.cookie.split(';')) {
        const name = part.trim().split('=', 1)[0];
        if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
    }
}

const signedInAs = (user: TestUser): TestSession => ({ access_token: 'old-token', user });
const emit = (event: string) => mocks.listeners.forEach((listener) => listener(event, mocks.session));

/** `lost` is a request whose connection failed: it may or may not have arrived. */
type Answer = { status?: number; body?: unknown; lost?: true };
const payouts = (availableTokenSubunits: number, availableUsd: string, canRequest: boolean): Answer => ({
    body: {
        success: true,
        availableTokenSubunits,
        heldTokenSubunits: 0,
        availableUsd,
        minimumTokenSubunits: 1_000_000,
        minimumUsd: '$100.00',
        canRequest,
        pendingRequest: null,
        history: [],
    },
});
const reauthenticationRequired: Answer = {
    status: 403,
    body: {
        error: 'Please sign in again before permanently deleting your account.',
        code: 'RECENT_AUTH_REQUIRED',
        reason: 'reauthentication_required',
        reauthenticate: true,
    },
};
const scheduled: Answer = { status: 202, body: { success: true, deleted: false, deletionScheduled: true } };

/** Answers the payout read and each deletion request in turn, keeping every request made. */
function answerRequests({ payout = payouts(0, '$0.00', false), deletions = [scheduled] }: {
    payout?: Answer;
    deletions?: Answer[];
} = {}) {
    const deletionAnswers = [...deletions];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
        const answer = input === '/api/account' ? deletionAnswers.shift() ?? scheduled : payout;
        if (answer.lost) throw new TypeError('Failed to fetch');
        const status = answer.status ?? 200;
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => {
                if (answer.body === undefined) throw new SyntaxError('Unexpected end of JSON input');
                return answer.body;
            },
            init,
        };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}
const deletionRequests = (fetchMock: ReturnType<typeof answerRequests>) => fetchMock.mock.calls
    .filter(([url]) => url === '/api/account')
    .map(([, init]) => init as RequestInit);

const deletionSection = () => screen.findByRole('region', { name: 'Delete your account now' });

async function confirmDeletion() {
    const section = await deletionSection();
    fireEvent.change(within(section).getByLabelText('Type DELETE to confirm'), { target: { value: 'delete' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Permanently delete account' }));
    return section;
}

describe('account deletion page', () => {
    beforeEach(() => {
        mocks.session = null;
        mocks.listeners.clear();
        mocks.router.push.mockReset();
        mocks.signOut.mockReset();
        mocks.signOut.mockImplementation(async () => {
            mocks.session = null;
            emit('SIGNED_OUT');
            return { error: null };
        });
        mocks.getUser.mockReset();
        mocks.getUser.mockResolvedValue({ data: { user: null }, error: unreachable });
        mocks.clearPersistedCreatorData.mockReset();
        mocks.clearPersistedCreatorData.mockResolvedValue(undefined);
        mocks.signInWithPassword.mockReset();
        mocks.signInWithPassword.mockImplementation(async ({ password }: { email: string; password: string }) => {
            if (password !== PASSWORD) {
                return { data: { session: null, user: null }, error: new Error('Invalid login credentials') };
            }
            mocks.session = { access_token: 'fresh-token', user: emailUser };
            emit('SIGNED_IN');
            return { data: { session: mocks.session, user: emailUser }, error: null };
        });
    });

    afterEach(() => {
        cleanup();
        clearCookies();
        window.localStorage.clear();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('publishes store-compliant deletion steps and retention information', () => {
        const html = renderToString(<DeleteAccountPage />);

        expect(html).toContain(`Delete your ${siteConfig.name} account`);
        // Home's top-left control is the menu glyph; there is no avatar to tap.
        expect(html).toContain('On Home, tap the menu (☰) at the top left, then Settings.');
        expect(html).toContain('Sign in again when asked; an account that uses Sign in with Apple must do this on an iPhone.');
        expect(html).toContain('type DELETE');
        expect(html).toContain('What permanent deletion removes');
        expect(html).toContain('Your public posts and comments.');
        expect(html).toContain('People who bought your recipes keep them.');
        expect(html).toContain('Data we may retain');
        expect(html).toContain('Request account deletion');
        // The brand is printed one way, from the site config.
        expect(html).not.toContain('Magicbooklet');
        expect(html).toContain(encodeURIComponent(`${siteConfig.name} account deletion request`));
    });

    it('keeps the instructions and the email route for a signed-out visitor', async () => {
        const fetchMock = answerRequests();
        render(<DeleteAccountPage />);
        await act(async () => undefined);

        expect(screen.getByRole('link', { name: 'Request account deletion' })).toBeInTheDocument();
        // Signing in brings the reader back here, to the section below.
        expect(screen.getByRole('link', { name: 'sign in' })).toHaveAttribute('href', '/login?returnUrl=/delete-account');
        expect(screen.queryByRole('region', { name: 'Delete your account now' })).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("warns a seller what deletion takes: the unpaid balance, the public posts, the buyers' recipes", async () => {
        mocks.session = signedInAs(emailUser);
        const fetchMock = answerRequests({ payout: payouts(1_250_000, '$125.00', true) });
        render(<DeleteAccountPage />);

        const section = await deletionSection();
        const earnings = await within(section).findByText(/Unpaid sales earnings of \$125\.00 will be forfeited\./);
        expect(earnings).toHaveTextContent('Unpaid sales earnings of $125.00 will be forfeited. Request a payout first.');
        expect(within(earnings).getByRole('link', { name: 'Request a payout first' })).toHaveAttribute('href', '/marketplace/sell');
        expect(within(section).getByText('Your public posts and comments will be removed.')).toBeInTheDocument();
        expect(within(section).getByText('People who bought your recipes keep them.')).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith('/api/creator/payouts', expect.objectContaining({
            headers: { Authorization: 'Bearer old-token' },
        }));
    });

    it('names no amount without a balance, and still warns when the balance cannot be read', async () => {
        mocks.session = signedInAs(emailUser);
        answerRequests({ payout: payouts(0, '$0.00', false) });
        const { unmount } = render(<DeleteAccountPage />);
        const section = await deletionSection();
        await waitFor(() => expect(within(section).getByText('Your public posts and comments will be removed.')).toBeInTheDocument());
        await act(async () => undefined);
        expect(within(section).queryByText(/Unpaid sales earnings/)).toBeNull();
        unmount();

        vi.unstubAllGlobals();
        answerRequests({ payout: { status: 500, body: { error: 'Failed to load your payout balance.' } } });
        render(<DeleteAccountPage />);
        const failed = await within(await deletionSection()).findByText(/Unpaid sales earnings, if you have any, will be forfeited\./);
        expect(within(failed).getByRole('link', { name: 'Check your balance' })).toHaveAttribute('href', '/marketplace/sell');
    });

    // 202: the account is locked and every session ended; the sweep runs behind the answer.
    it('deletes the account from the page, then says so and signs this browser out', async () => {
        mocks.session = signedInAs(emailUser);
        const fetchMock = answerRequests({ deletions: [scheduled] });
        render(<DeleteAccountPage />);

        await confirmDeletion();

        expect(await screen.findByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
        const [request] = deletionRequests(fetchMock);
        expect(request).toMatchObject({ method: 'DELETE', headers: expect.objectContaining({ Authorization: 'Bearer old-token' }) });
        expect(JSON.parse(String(request.body))).toEqual({ confirmation: 'DELETE' });
        await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' }));
        // The notice outlives the session it ended.
        expect(screen.getByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute('href', '/login');
        expect(screen.queryByRole('region', { name: 'Delete your account now' })).toBeNull();
    });

    // The browser's other tabs take the ending for a sign-out, not a lapse, and an open creator
    // page there clears (owner, 2026-11-01).
    it('marks its sign-out for the browser’s other tabs before the session ends', async () => {
        const accessToken = unsignedJwt({ sub: emailUser.id, session_id: 'session-1' });
        mocks.session = { access_token: accessToken, user: emailUser };
        answerRequests({ deletions: [scheduled] });
        let markedAsItEnded = false;
        mocks.signOut.mockImplementation(async () => {
            markedAsItEnded = wasSignedOutInBrowser(accessToken);
            mocks.session = null;
            emit('SIGNED_OUT');
            return { error: null };
        });
        render(<DeleteAccountPage />);

        await confirmDeletion();

        await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' }));
        expect(markedAsItEnded).toBe(true);
    });

    // The deletion ends every session of the account as it starts, before it answers, and a tab can
    // hear of that end first: the mark goes before the request.
    describe('telling the browser’s other tabs', () => {
        const tokenOf = (user: TestUser, sessionId: string) => unsignedJwt({ sub: user.id, session_id: sessionId });

        it('marks the session before the deletion request ends it', async () => {
            const accessToken = tokenOf(emailUser, 'session-1');
            mocks.session = { access_token: accessToken, user: emailUser };
            const fetchMock = answerRequests({ deletions: [scheduled] });
            const answer = fetchMock.getMockImplementation()!;
            let markedAsSent: boolean | null = null;
            fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
                if (input === '/api/account') markedAsSent = wasSignedOutInBrowser(accessToken);
                return answer(input, init);
            });
            render(<DeleteAccountPage />);

            await confirmDeletion();

            expect(await screen.findByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
            expect(markedAsSent).toBe(true);
            expect(wasSignedOutInBrowser(accessToken)).toBe(true);
        });

        it('has marked the session before the probe of an unclear answer finds it ended', async () => {
            const accessToken = tokenOf(emailUser, 'session-1');
            mocks.session = { access_token: accessToken, user: emailUser };
            answerRequests({ deletions: [{ status: 401, body: { error: 'Unauthorized' } }] });
            let markedAsProbed: boolean | null = null;
            mocks.getUser.mockImplementation(async () => {
                markedAsProbed = wasSignedOutInBrowser(accessToken);
                // auth-js removes a session it finds gone, and every tab hears of it before this page signs out.
                mocks.session = null;
                emit('SIGNED_OUT');
                return { data: { user: null }, error: sessionMissing };
            });
            render(<DeleteAccountPage />);

            await confirmDeletion();

            expect(await screen.findByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
            expect(markedAsProbed).toBe(true);
            expect(wasSignedOutInBrowser(accessToken)).toBe(true);
        });

        it('marks the new session and the one the page held, for a password re-check', async () => {
            const heldToken = tokenOf(emailUser, 'session-1');
            const freshToken = tokenOf(emailUser, 'session-2');
            mocks.session = { access_token: heldToken, user: emailUser };
            mocks.signInWithPassword.mockImplementation(async () => {
                mocks.session = { access_token: freshToken, user: emailUser };
                emit('SIGNED_IN');
                return { data: { session: mocks.session, user: emailUser }, error: null };
            });
            answerRequests({ deletions: [reauthenticationRequired, scheduled] });
            render(<DeleteAccountPage />);

            const section = await confirmDeletion();
            fireEvent.change(await within(section).findByLabelText('Current password'), { target: { value: PASSWORD } });
            fireEvent.click(within(section).getByRole('button', { name: 'Verify password and delete' }));

            expect(await screen.findByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
            expect(wasSignedOutInBrowser(freshToken)).toBe(true);
            // A tab that had not taken the new session yet still holds the old one.
            expect(wasSignedOutInBrowser(heldToken)).toBe(true);
        });

        // The sign-in-again link signs out only so the same person can sign straight back in: the
        // other tabs read it as a lapse, and a creator page there keeps its form for their return.
        it('takes the mark back when the deletion asks for a fresh sign-in, and its sign-in-again leaves none', async () => {
            const accessToken = tokenOf(googleUser, 'session-1');
            mocks.session = { access_token: accessToken, user: googleUser };
            answerRequests({ deletions: [reauthenticationRequired] });
            let markedAsItEnded: boolean | null = null;
            mocks.signOut.mockImplementation(async () => {
                markedAsItEnded = wasSignedOutInBrowser(accessToken);
                mocks.session = null;
                emit('SIGNED_OUT');
                return { error: null };
            });
            render(<DeleteAccountPage />);

            const section = await confirmDeletion();
            const signInAgain = await within(section).findByRole('link', { name: 'Sign in again to continue' });
            expect(wasSignedOutInBrowser(accessToken)).toBe(false);

            fireEvent.click(signInAgain);

            await waitFor(() => expect(mocks.router.push).toHaveBeenCalledWith('/login?returnUrl=/delete-account'));
            expect(markedAsItEnded).toBe(false);
        });
    });

    it('re-checks an email account with its password, then goes on deleting with the new session', async () => {
        mocks.session = signedInAs(emailUser);
        const consoleCalls = ['log', 'info', 'warn', 'error', 'debug'].map((method) => (
            vi.spyOn(console, method as 'log').mockImplementation(() => undefined)
        ));
        const fetchMock = answerRequests({ deletions: [reauthenticationRequired, scheduled] });
        render(<DeleteAccountPage />);

        const section = await confirmDeletion();
        const passwordField = await within(section).findByLabelText('Current password');
        expect(within(section).queryByRole('link', { name: 'Sign in again to continue' })).toBeNull();

        fireEvent.change(passwordField, { target: { value: 'wrong-password' } });
        fireEvent.click(within(section).getByRole('button', { name: 'Verify password and delete' }));
        expect(await within(section).findByRole('alert')).toHaveTextContent('That password does not match this account. Try again.');
        expect(passwordField).toHaveValue('');
        expect(deletionRequests(fetchMock)).toHaveLength(1);

        fireEvent.change(passwordField, { target: { value: PASSWORD } });
        fireEvent.click(within(section).getByRole('button', { name: 'Verify password and delete' }));

        expect(await screen.findByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
        expect(mocks.signInWithPassword).toHaveBeenLastCalledWith({ email: 'creator@example.com', password: PASSWORD });
        const requests = deletionRequests(fetchMock);
        expect(requests).toHaveLength(2);
        expect(requests[1].headers).toMatchObject({ Authorization: 'Bearer fresh-token' });
        // The password is never printed.
        for (const spy of consoleCalls) {
            for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(PASSWORD);
        }
    });

    it('sends a Google account to sign in again, signed out here first so the sign-in page does not bounce it back', async () => {
        mocks.session = signedInAs(googleUser);
        answerRequests({ deletions: [reauthenticationRequired] });
        render(<DeleteAccountPage />);

        const section = await confirmDeletion();
        const signInAgain = await within(section).findByRole('link', { name: 'Sign in again to continue' });
        expect(signInAgain).toHaveAttribute('href', '/login?returnUrl=/delete-account');
        expect(within(section).queryByLabelText('Current password')).toBeNull();

        fireEvent.click(signInAgain);

        await waitFor(() => expect(mocks.router.push).toHaveBeenCalledWith('/login?returnUrl=/delete-account'));
        expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
        expect(mocks.signOut.mock.invocationCallOrder[0]).toBeLessThan(mocks.router.push.mock.invocationCallOrder[0]);
    });

    it('tells an Apple-linked account to use the app when the server asks for Apple', async () => {
        mocks.session = signedInAs(emailUser);
        answerRequests({
            deletions: [{
                status: 403,
                body: {
                    error: 'Continue with Apple before permanently deleting your account.',
                    code: 'APPLE_REAUTH_REQUIRED',
                    reason: 'reauthentication_required',
                    reauthenticate: true,
                },
            }],
        });
        render(<DeleteAccountPage />);

        const section = await confirmDeletion();

        expect(await within(section).findByRole('heading', { name: 'Delete this account in the app' })).toBeInTheDocument();
        expect(within(section).getByText(/uses Sign in with Apple/)).toHaveTextContent('on an iPhone');
        expect(within(section).queryByLabelText('Type DELETE to confirm')).toBeNull();
        expect(within(section).queryByLabelText('Current password')).toBeNull();
        expect(mocks.signOut).not.toHaveBeenCalled();
    });

    it('sends an account known to use Sign in with Apple to the app before anything is typed', async () => {
        mocks.session = signedInAs(appleUser);
        const fetchMock = answerRequests();
        render(<DeleteAccountPage />);

        const section = await deletionSection();

        expect(within(section).getByRole('heading', { name: 'Delete this account in the app' })).toBeInTheDocument();
        expect(within(section).queryByLabelText('Type DELETE to confirm')).toBeNull();
        expect(deletionRequests(fetchMock)).toHaveLength(0);
    });

    // A deletion already started, here or from the app.
    it('treats 409 ACCOUNT_DELETING as a deletion under way and signs this browser out', async () => {
        mocks.session = signedInAs(emailUser);
        answerRequests({
            deletions: [{ status: 409, body: { error: 'This account is being permanently deleted.', code: 'ACCOUNT_DELETING' } }],
        });
        render(<DeleteAccountPage />);

        await confirmDeletion();

        expect(await screen.findByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
        await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' }));
    });

    it('says the account is still there only when the server says nothing started', async () => {
        mocks.session = signedInAs(emailUser);
        answerRequests({
            deletions: [
                {
                    status: 500,
                    body: {
                        error: 'Account deletion could not be completed. Please try again.',
                        code: 'ACCOUNT_DELETION_NOT_STARTED',
                        deletionScheduled: false,
                    },
                },
                {
                    status: 500,
                    body: {
                        error: 'Your account is being deleted and will be removed automatically.',
                        code: 'ACCOUNT_DELETION_RETRY_SCHEDULED',
                        deletionScheduled: true,
                    },
                },
            ],
        });
        render(<DeleteAccountPage />);

        const section = await confirmDeletion();
        expect(await within(section).findByRole('alert')).toHaveTextContent(
            'Your account was not deleted. Account deletion could not be completed. Please try again.',
        );
        expect(mocks.signOut).not.toHaveBeenCalled();
        // The route's own answer is taken at its word.
        expect(mocks.getUser).not.toHaveBeenCalled();

        fireEvent.click(within(section).getByRole('button', { name: 'Permanently delete account' }));

        expect(await screen.findByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
        await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' }));
    });

    // Audit 04-7: the menu's sign-out already cleared these; the deletion did not.
    it("clears the account's drafts and staged files in this browser before signing out", async () => {
        mocks.session = signedInAs(emailUser);
        answerRequests({ deletions: [scheduled] });
        const order: string[] = [];
        mocks.clearPersistedCreatorData.mockImplementation(async () => {
            order.push('clear');
        });
        mocks.signOut.mockImplementation(async () => {
            order.push('signOut');
            mocks.session = null;
            emit('SIGNED_OUT');
            return { error: null };
        });
        render(<DeleteAccountPage />);

        await confirmDeletion();

        expect(await screen.findByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
        await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' }));
        expect(mocks.clearPersistedCreatorData).toHaveBeenCalledWith('user-email');
        expect(order).toEqual(['clear', 'signOut']);
    });

    // Audit 04-4: auth-js keeps the session when its logout call fails, and the
    // sign-in page sends a browser holding one straight back.
    describe('when the logout call fails', () => {
        beforeEach(() => {
            vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
            document.cookie = `${AUTH_COOKIE}.0=chunk-zero; Path=/`;
            document.cookie = `${AUTH_COOKIE}.1=chunk-one; Path=/`;
            mocks.signOut.mockResolvedValue({ error: unreachable });
        });

        it('still ends the session in this browser after a deletion', async () => {
            mocks.session = signedInAs(emailUser);
            answerRequests({ deletions: [scheduled] });
            render(<DeleteAccountPage />);

            await confirmDeletion();

            expect(await screen.findByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
            await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' }));
            await waitFor(() => expect(document.cookie).toBe(''));
        });

        it('still sends Sign in again to the sign-in page signed out', async () => {
            mocks.session = signedInAs(googleUser);
            answerRequests({ deletions: [reauthenticationRequired] });
            render(<DeleteAccountPage />);

            const section = await confirmDeletion();
            fireEvent.click(await within(section).findByRole('link', { name: 'Sign in again to continue' }));

            await waitFor(() => expect(mocks.router.push).toHaveBeenCalledWith('/login?returnUrl=/delete-account'));
            expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
            expect(document.cookie).toBe('');
        });
    });

    // Audit 04-3: a lost answer, a 401 or a platform 5xx cannot say whether the
    // deletion started; the session the request carried can.
    describe('an answer that cannot say whether the deletion started', () => {
        it.each<[string, Answer]>([
            ['a lost answer', { lost: true }],
            ['a 401', { status: 401, body: { error: 'Unauthorized' } }],
            ['a 502 without JSON', { status: 502 }],
        ])('after %s, a session Supabase no longer has means the deletion started', async (_label, answer) => {
            mocks.session = signedInAs(emailUser);
            answerRequests({ deletions: [answer] });
            mocks.getUser.mockResolvedValue({ data: { user: null }, error: sessionMissing });
            render(<DeleteAccountPage />);

            await confirmDeletion();

            expect(await screen.findByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
            expect(mocks.getUser).toHaveBeenCalledWith('old-token');
            await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' }));
        });

        it('takes an account Supabase no longer has as deleted', async () => {
            mocks.session = signedInAs(emailUser);
            answerRequests({ deletions: [{ status: 401, body: { error: 'Unauthorized' } }] });
            mocks.getUser.mockResolvedValue({
                data: { user: null },
                error: { name: 'AuthApiError', message: 'User from sub claim in JWT does not exist', status: 403, code: 'user_not_found' },
            });
            render(<DeleteAccountPage />);

            await confirmDeletion();

            expect(await screen.findByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
        });

        it.each<[string, Answer]>([
            ['a lost answer', { lost: true }],
            ['a 401', { status: 401, body: { error: 'Unauthorized' } }],
            ['a 500 without JSON', { status: 500 }],
        ])('after %s, a session Supabase still accepts means the account is still active', async (_label, answer) => {
            mocks.session = signedInAs(emailUser);
            answerRequests({ deletions: [answer] });
            mocks.getUser.mockResolvedValue({ data: { user: emailUser }, error: null });
            render(<DeleteAccountPage />);

            const section = await confirmDeletion();

            expect(await within(section).findByRole('alert')).toHaveTextContent(
                'Your account was not deleted. The deletion did not go through. Your account is still active.',
            );
            expect(mocks.getUser).toHaveBeenCalledWith('old-token');
            expect(mocks.signOut).not.toHaveBeenCalled();
            expect(within(section).getByRole('button', { name: 'Permanently delete account' })).toBeInTheDocument();
        });

        it('says it could not confirm the deletion when Supabase cannot answer either', async () => {
            mocks.session = signedInAs(emailUser);
            answerRequests({ deletions: [{ status: 504 }] });
            render(<DeleteAccountPage />);

            const section = await confirmDeletion();

            expect(await within(section).findByRole('alert')).toHaveTextContent(
                'We could not confirm the deletion. Check the connection and try again.',
            );
            expect(mocks.getUser).toHaveBeenCalledWith('old-token');
            expect(mocks.signOut).not.toHaveBeenCalled();
            expect(within(section).getByRole('button', { name: 'Permanently delete account' })).toBeInTheDocument();
        });
    });

    // A hidden <Activity> runs every cleanup and every effect again.
    it('keeps one session listener and the section when every effect runs again', async () => {
        mocks.session = signedInAs(emailUser);
        const fetchMock = answerRequests({ payout: payouts(250_000, '$25.00', false) });
        const inActivity = (mode: 'visible' | 'hidden') => (
            <Activity mode={mode}>
                <DeleteAccountPage />
            </Activity>
        );
        const { rerender } = render(inActivity('visible'));
        await within(await deletionSection()).findByText(/Unpaid sales earnings of \$25\.00 will be forfeited\./);

        rerender(inActivity('hidden'));
        rerender(inActivity('visible'));
        // The positive control: the effects did run again.
        await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/creator/payouts')).toHaveLength(2));

        expect(mocks.listeners.size).toBe(1);
        const section = await deletionSection();
        expect(within(section).getByText(/Unpaid sales earnings of \$25\.00 will be forfeited\./)).toBeInTheDocument();
        expect(within(section).queryByRole('link', { name: 'Request a payout first' })).toBeNull();
        expect(within(section).getAllByLabelText('Type DELETE to confirm')).toHaveLength(1);
    });
});
