import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Activity } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeleteAccountPage from '@/app/delete-account/page';
import { readAppleWebAuthorizationStart, rememberAppleWebAuthorizationStart } from '@/lib/apple-web-reauthentication';
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
/** A Google account Supabase linked a website Apple sign-in to, by the same verified email. */
const googleAppleUser: TestUser = {
    id: 'user-google-apple',
    email: 'both@example.com',
    app_metadata: { provider: 'google', providers: ['google', 'apple'] },
    identities: [{ provider: 'google' }, { provider: 'apple' }],
};
const SERVICES_ID = 'com.magicbooklet.mobile.web';
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
        window.sessionStorage.clear();
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
        // Such an account signs in on the website too, but is deleted in the app.
        expect(html).toContain('An account that uses Sign in with Apple is deleted in the app on an iPhone.');
        // Without an iPhone that is the email request, which a Hide My Email address cannot send.
        expect(html).toContain('If you use Sign in with Apple with Hide My Email, write from any address and include your handle.');
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

    // Such an account signs in here too, and is deleted in the app: the deletion revokes Apple's
    // authorization with a native sign-in's one-time code.
    it('sends an account known to use Sign in with Apple to the app before anything is typed', async () => {
        mocks.session = signedInAs(appleUser);
        const fetchMock = answerRequests();
        render(<DeleteAccountPage />);

        const section = await deletionSection();

        expect(within(section).getByRole('heading', { name: 'Delete this account in the app' })).toBeInTheDocument();
        expect(within(section).getByRole('status')).toHaveTextContent(
            `This account uses Sign in with Apple, so it is deleted in the ${siteConfig.name} app on an iPhone, where Apple confirms it is you and ${siteConfig.name} is disconnected from your Apple ID. Tap the menu (☰) at the top left of Home, then choose Settings and Delete account. No iPhone? Request deletion by email below.`,
        );
        expect(within(section).queryByText(/does not offer/)).toBeNull();
        expect(within(section).queryByLabelText('Type DELETE to confirm')).toBeNull();
        expect(deletionRequests(fetchMock)).toHaveLength(0);
        // The email route the notice points to.
        expect(screen.getByRole('link', { name: 'Request account deletion' })).toBeInTheDocument();
    });

    it('says where an account that uses Sign in with Apple confirms it, once the website has a Services ID', () => {
        vi.stubEnv('NEXT_PUBLIC_APPLE_SERVICES_ID', SERVICES_ID);
        const host = new URL(siteConfig.siteUrl).host;

        const html = renderToString(<DeleteAccountPage />);

        // Named: the page is also served on hosts Apple does not return to.
        expect(html).toContain(`An account that uses Sign in with Apple confirms it with Apple, on ${host} or in the app on an iPhone.`);
        expect(html).toContain(`Sign in again when asked; an account that uses Sign in with Apple does this on an iPhone, or is deleted on ${host} instead.`);
        expect(html).not.toContain('is deleted in the app on an iPhone');
        expect(html).toContain('If you use Sign in with Apple with Hide My Email, write from any address and include your handle.');
    });

    // Apple confirms the person on its own page and sends them back here with a one-time code,
    // which the deletion redeems as the website's Services ID.
    describe('Continue with Apple on the website', () => {
        const siteOrigin = new URL(siteConfig.siteUrl).origin;

        /** This page on `origin`, `hash` in its address; `assign` records where it leaves for. */
        function openPage(hash = '', origin = siteOrigin) {
            const assign = vi.fn();
            vi.stubGlobal('location', { ...window.location, origin, pathname: '/delete-account', search: '', hash, assign });
            return assign;
        }
        const appleRefusal = (code: string, error: string, reauthenticate: boolean): Answer => ({
            status: 403,
            body: {
                error,
                code,
                ...(reauthenticate ? { reason: 'reauthentication_required', reauthenticate: true } : {}),
            },
        });
        const appleUnavailable: Answer = {
            status: 503,
            body: {
                error: 'Apple account verification is temporarily unavailable. Your account is still active; please try again later.',
                code: 'APPLE_REVOCATION_UNAVAILABLE',
            },
        };
        const codeSent = (request: RequestInit) => (JSON.parse(String(request.body)) as { appleAuthorizationCode?: string }).appleAuthorizationCode;

        beforeEach(() => {
            vi.stubEnv('NEXT_PUBLIC_APPLE_SERVICES_ID', SERVICES_ID);
        });

        afterEach(() => {
            window.history.replaceState(null, '', '/');
        });

        it.each([
            ['an account made with Apple', appleUser],
            ['a Google account linked to an Apple sign-in', googleAppleUser],
        ])('sends %s to Apple as the Services ID, keeping the start in this tab', async (_label, user) => {
            mocks.session = signedInAs(user);
            mocks.getUser.mockResolvedValue({ data: { user }, error: null });
            const assign = openPage();
            const fetchMock = answerRequests();
            render(<DeleteAccountPage />);

            const section = await deletionSection();
            expect(within(section).getByRole('heading', { name: 'Confirm with Apple' })).toBeInTheDocument();
            // Nothing to confirm until Apple has: the code comes back with the person.
            expect(within(section).queryByLabelText('Type DELETE to confirm')).toBeNull();
            expect(within(section).queryByLabelText('Current password')).toBeNull();

            fireEvent.click(within(section).getByRole('button', { name: 'Continue with Apple' }));

            await waitFor(() => expect(assign).toHaveBeenCalledOnce());
            // Supabase is asked about the stored session first.
            expect(mocks.getUser).toHaveBeenCalledWith();
            const appleUrl = new URL(String(assign.mock.calls[0][0]));
            const start = readAppleWebAuthorizationStart();
            expect(start).toEqual({ state: expect.any(String), userId: user.id });
            expect(start!.state.length).toBeGreaterThanOrEqual(32);
            expect(`${appleUrl.origin}${appleUrl.pathname}`).toBe('https://appleid.apple.com/auth/authorize');
            expect(Object.fromEntries(appleUrl.searchParams)).toEqual({
                client_id: SERVICES_ID,
                redirect_uri: `${siteOrigin}/delete-account`,
                response_type: 'code',
                response_mode: 'fragment',
                state: start!.state,
            });
            expect(deletionRequests(fetchMock)).toHaveLength(0);
        });

        it.each([
            ['an account made with Apple', appleUser],
            ['a Google account linked to an Apple sign-in', googleAppleUser],
        ])('deletes %s with the code Apple brings back, once DELETE is typed', async (_label, user) => {
            mocks.session = signedInAs(user);
            rememberAppleWebAuthorizationStart({ state: 'state-1', userId: user.id });
            window.history.replaceState({ __NA: true }, '', '/delete-account');
            openPage('#code=apple-code-1&state=state-1');
            const replaceState = vi.spyOn(window.history, 'replaceState');
            const fetchMock = answerRequests({ deletions: [scheduled] });
            render(<DeleteAccountPage />);

            const section = await deletionSection();
            expect(within(section).getByRole('status')).toHaveTextContent('Apple confirmed it is you. Type DELETE to finish deleting the account.');
            // Kept for Back to Apple's page, which can confirm again with the same state.
            expect(readAppleWebAuthorizationStart()).toEqual({ state: 'state-1', userId: user.id });
            // The code leaves the address at once, keeping Next's history state; then through
            // Next's patched history (a null state), so its router takes the clean address too.
            await waitFor(() => expect(replaceState).toHaveBeenCalledTimes(2));
            expect(replaceState.mock.calls).toEqual([[{ __NA: true }, '', '/delete-account'], [null, '', '/delete-account']]);
            expect(deletionRequests(fetchMock)).toHaveLength(0);

            await confirmDeletion();

            expect(await screen.findByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
            expect(readAppleWebAuthorizationStart()).toBeNull();
            const [request] = deletionRequests(fetchMock);
            expect(request.headers).toMatchObject({ Authorization: 'Bearer old-token' });
            expect(JSON.parse(String(request.body))).toEqual({
                confirmation: 'DELETE',
                appleAuthorizationCode: 'apple-code-1',
                appleAuthorizationClient: 'web',
            });
            await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' }));
        });

        // A link to Apple's page from anywhere else comes back with a code too: only the start
        // this tab kept, for the account signed in, lets one through.
        it.each<[string, { state: string; userId: string } | null]>([
            ['no start in this tab', null],
            ['a start with another state', { state: 'state-1', userId: appleUser.id }],
            ['a start for another account', { state: 'state-2', userId: 'user-someone-else' }],
        ])('deletes nothing with a code that answers %s', async (_label, start) => {
            mocks.session = signedInAs(appleUser);
            if (start) rememberAppleWebAuthorizationStart(start);
            openPage('#code=apple-code-2&state=state-2');
            const replaceState = vi.spyOn(window.history, 'replaceState');
            const fetchMock = answerRequests();
            render(<DeleteAccountPage />);

            const section = await deletionSection();
            expect(within(section).getByRole('alert')).toHaveTextContent(
                'That Apple confirmation was not started on this page, so nothing was deleted. Continue with Apple here to delete this account.',
            );
            expect(within(section).getByRole('button', { name: 'Continue with Apple' })).toBeInTheDocument();
            expect(within(section).queryByLabelText('Type DELETE to confirm')).toBeNull();
            expect(replaceState).toHaveBeenCalledWith(null, '', '/delete-account');
            expect(deletionRequests(fetchMock)).toHaveLength(0);
        });

        it("says Apple's Cancel deleted nothing, and offers Continue with Apple again", async () => {
            mocks.session = signedInAs(appleUser);
            rememberAppleWebAuthorizationStart({ state: 'state-1', userId: appleUser.id });
            openPage('#error=user_cancelled_authorize&state=state-1');
            const fetchMock = answerRequests();
            render(<DeleteAccountPage />);

            const section = await deletionSection();
            expect(within(section).getByRole('alert')).toHaveTextContent('You cancelled Continue with Apple. Your account was not deleted.');
            expect(within(section).getByRole('button', { name: 'Continue with Apple' })).toBeInTheDocument();
            expect(deletionRequests(fetchMock)).toHaveLength(0);
        });

        // The server sends the person back to Apple: the code is no use any more.
        it.each<[string, Answer, string]>([
            [
                'Apple refuses the code',
                appleRefusal('APPLE_REAUTH_FAILED', 'Apple could not verify this deletion request. Continue with Apple again and retry.', true),
                'Your account was not deleted. Apple could not verify this deletion request. Continue with Apple again and retry.',
            ],
            [
                'Apple confirmed another Apple ID',
                appleRefusal('ACCOUNT_REAUTH_MISMATCH', 'You continued with a different Apple account. Your Magicbooklet account was not deleted.', false),
                'Your account was not deleted. You continued with a different Apple ID. Continue with the Apple ID this account uses.',
            ],
        ])('continues with Apple again after %s', async (_label, answer, alert) => {
            mocks.session = signedInAs(appleUser);
            rememberAppleWebAuthorizationStart({ state: 'state-1', userId: appleUser.id });
            openPage('#code=apple-code-1&state=state-1');
            const fetchMock = answerRequests({ deletions: [answer] });
            render(<DeleteAccountPage />);

            const section = await confirmDeletion();

            expect(await within(section).findByRole('alert')).toHaveTextContent(alert);
            expect(within(section).getByRole('button', { name: 'Continue with Apple' })).toBeInTheDocument();
            expect(within(section).queryByLabelText('Type DELETE to confirm')).toBeNull();
            expect(deletionRequests(fetchMock)).toHaveLength(1);
            expect(mocks.signOut).not.toHaveBeenCalled();
            expect(mocks.getUser).not.toHaveBeenCalled();
        });

        // An answer that leaves the account as it was, or cannot say: the form stays, and the
        // retry sends the same code. A deletion that did start answers it as under way, and
        // sending the person back to Apple would add an authorization nothing revokes.
        it.each<[string, Answer, string]>([
            ["Apple's service is unavailable", appleUnavailable, 'Your account was not deleted. Apple account verification is temporarily unavailable.'],
            ['an answer that cannot say whether the deletion started', { lost: true }, 'We could not confirm the deletion. Check the connection and try again.'],
        ])('keeps the code after %s, and the retry sends it again', async (_label, answer, alert) => {
            mocks.session = signedInAs(appleUser);
            rememberAppleWebAuthorizationStart({ state: 'state-1', userId: appleUser.id });
            openPage('#code=apple-code-1&state=state-1');
            const fetchMock = answerRequests({ deletions: [answer, { status: 409, body: { error: 'This account is being permanently deleted.', code: 'ACCOUNT_DELETING' } }] });
            render(<DeleteAccountPage />);

            const section = await confirmDeletion();

            expect(await within(section).findByRole('alert')).toHaveTextContent(alert);
            expect(within(section).queryByRole('button', { name: 'Continue with Apple' })).toBeNull();
            fireEvent.click(within(section).getByRole('button', { name: 'Permanently delete account' }));

            expect(await screen.findByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
            expect(deletionRequests(fetchMock).map(codeSent)).toEqual(['apple-code-1', 'apple-code-1']);
        });

        // The server reads the account's identities afresh; this browser's copy may still list Apple.
        it('shows the fresh sign-in the server asks for, though this browser still lists Apple', async () => {
            mocks.session = signedInAs(appleUser);
            rememberAppleWebAuthorizationStart({ state: 'state-1', userId: appleUser.id });
            openPage('#code=apple-code-1&state=state-1');
            answerRequests({ deletions: [reauthenticationRequired] });
            render(<DeleteAccountPage />);

            const section = await confirmDeletion();

            expect(await within(section).findByRole('heading', { name: 'Confirm it is you' })).toBeInTheDocument();
            expect(within(section).getByRole('link', { name: 'Sign in again to continue' })).toBeInTheDocument();
            // No Google identity to name.
            expect(within(section).getByText('Sign in again, then confirm the deletion here.')).toBeInTheDocument();
            expect(within(section).queryByRole('button', { name: 'Continue with Apple' })).toBeNull();
        });

        // A refusal read as the page opened is said before anything is sent, never as the
        // answer to a later deletion request.
        it("does not show Apple's earlier answer as the answer to a later request", async () => {
            mocks.session = signedInAs(googleUser);
            // An answer this tab did not start, for an account this browser lists without Apple.
            openPage('#error=user_cancelled_authorize&state=state-2');
            answerRequests({
                deletions: [appleRefusal('APPLE_REAUTH_REQUIRED', 'Continue with Apple before permanently deleting your account.', true)],
            });
            render(<DeleteAccountPage />);

            // The plain form, with nothing said about Apple.
            const section = await confirmDeletion();

            expect(await within(section).findByRole('button', { name: 'Continue with Apple' })).toBeInTheDocument();
            expect(within(section).queryByRole('alert')).toBeNull();
        });

        // The server asked for Apple, and this tab sent the account there: it has an Apple
        // identity, whatever this browser's copy of the account still lists.
        it("says Apple's Cancel deleted nothing for an account this browser lists without Apple", async () => {
            mocks.session = signedInAs(googleUser);
            rememberAppleWebAuthorizationStart({ state: 'state-1', userId: googleUser.id });
            openPage('#error=user_cancelled_authorize&state=state-1');
            const fetchMock = answerRequests();
            render(<DeleteAccountPage />);

            const section = await deletionSection();
            expect(within(section).getByRole('alert')).toHaveTextContent('You cancelled Continue with Apple. Your account was not deleted.');
            expect(within(section).getByRole('button', { name: 'Continue with Apple' })).toBeInTheDocument();
            expect(within(section).queryByLabelText('Type DELETE to confirm')).toBeNull();
            expect(deletionRequests(fetchMock)).toHaveLength(0);
        });

        // Back from the deletion page to Apple's, and Confirm again: Apple answers the same
        // state with a new code.
        it('takes a second confirmation of the same start, as after Back to Apple', async () => {
            mocks.session = signedInAs(appleUser);
            rememberAppleWebAuthorizationStart({ state: 'state-1', userId: appleUser.id });
            openPage('#code=apple-code-1&state=state-1');
            const fetchMock = answerRequests({ deletions: [scheduled] });
            const { unmount } = render(<DeleteAccountPage />);
            await deletionSection();
            unmount();

            openPage('#code=apple-code-3&state=state-1');
            render(<DeleteAccountPage />);
            const section = await deletionSection();
            expect(within(section).getByRole('status')).toHaveTextContent('Apple confirmed it is you.');
            await confirmDeletion();

            expect(await screen.findByText('Your account is being deleted. You have been signed out.')).toBeInTheDocument();
            expect(deletionRequests(fetchMock).map(codeSent)).toEqual(['apple-code-3']);
        });

        // A deletion elsewhere ended the session, but auth-js still holds it: Apple would confirm
        // for a request refused before its code is used, and nothing would revoke that.
        it.each<[string, { data: { user: TestUser | null }; error: Error | null }]>([
            ['Supabase says the session has ended', { data: { user: null }, error: sessionMissing }],
            ["the stored session is another account's", { data: { user: emailUser }, error: null }],
        ])('does not leave for Apple when %s', async (_label, answer) => {
            mocks.session = signedInAs(appleUser);
            mocks.getUser.mockResolvedValue(answer);
            const assign = openPage();
            answerRequests();
            render(<DeleteAccountPage />);

            const section = await deletionSection();
            fireEvent.click(within(section).getByRole('button', { name: 'Continue with Apple' }));

            expect(await within(section).findByText('Your session has ended. Sign in again, then confirm the deletion here.')).toBeInTheDocument();
            expect(assign).not.toHaveBeenCalled();
            expect(readAppleWebAuthorizationStart()).toBeNull();
        });

        it('takes one press of Continue with Apple while it checks the session', async () => {
            mocks.session = signedInAs(appleUser);
            let answerCheck: (answer: unknown) => void = () => undefined;
            mocks.getUser.mockImplementation(() => new Promise((resolve) => {
                answerCheck = resolve;
            }));
            const assign = openPage();
            answerRequests();
            render(<DeleteAccountPage />);

            const section = await deletionSection();
            const button = within(section).getByRole('button', { name: 'Continue with Apple' });
            fireEvent.click(button);
            await waitFor(() => expect(button).toBeDisabled());
            fireEvent.click(button);

            await act(async () => answerCheck({ data: { user: appleUser }, error: null }));
            await waitFor(() => expect(assign).toHaveBeenCalledOnce());
            expect(mocks.getUser).toHaveBeenCalledOnce();
        });

        it('says when it could not check the session before Continue with Apple', async () => {
            mocks.session = signedInAs(appleUser);
            // getUser cannot reach Supabase (the default here).
            const assign = openPage();
            answerRequests();
            render(<DeleteAccountPage />);

            const section = await deletionSection();
            fireEvent.click(within(section).getByRole('button', { name: 'Continue with Apple' }));

            expect(await within(section).findByRole('alert')).toHaveTextContent(
                'We could not check your session before Continue with Apple. Check the connection and try again.',
            );
            expect(within(section).getByRole('button', { name: 'Continue with Apple' })).toBeEnabled();
            expect(assign).not.toHaveBeenCalled();
            expect(readAppleWebAuthorizationStart()).toBeNull();
        });

        // Apple redeems a code once, within five minutes: past either, sending it again only
        // spends one of the hour's three attempts on Apple's refusal.
        it.each<[string, Answer, string]>([
            [
                "Apple's service fails after it took the code",
                { status: 503, body: { ...(appleUnavailable.body as object), appleCodeSpent: true } },
                'Your account was not deleted. Apple account verification is temporarily unavailable.',
            ],
            [
                'the deletion does not start after Apple took the code',
                {
                    status: 500,
                    body: {
                        error: 'Account deletion could not be completed. Please try again.',
                        code: 'ACCOUNT_DELETION_NOT_STARTED',
                        deletionScheduled: false,
                        appleCodeSpent: true,
                    },
                },
                'Your account was not deleted. Account deletion could not be completed. Please try again.',
            ],
        ])('asks for Apple again when %s', async (_label, answer, alert) => {
            mocks.session = signedInAs(appleUser);
            rememberAppleWebAuthorizationStart({ state: 'state-1', userId: appleUser.id });
            openPage('#code=apple-code-1&state=state-1');
            const fetchMock = answerRequests({ deletions: [answer] });
            render(<DeleteAccountPage />);

            const section = await confirmDeletion();

            expect(await within(section).findByRole('alert')).toHaveTextContent(alert);
            expect(within(section).getByRole('button', { name: 'Continue with Apple' })).toBeInTheDocument();
            expect(within(section).queryByLabelText('Type DELETE to confirm')).toBeNull();
            expect(deletionRequests(fetchMock)).toHaveLength(1);
            expect(mocks.signOut).not.toHaveBeenCalled();
        });

        it("asks for Apple again rather than send a code older than Apple's five minutes", async () => {
            const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 3, 10, 0, 0));
            mocks.session = signedInAs(appleUser);
            rememberAppleWebAuthorizationStart({ state: 'state-1', userId: appleUser.id });
            openPage('#code=apple-code-1&state=state-1');
            const fetchMock = answerRequests();
            render(<DeleteAccountPage />);
            const section = await deletionSection();
            expect(within(section).getByRole('status')).toHaveTextContent('Apple confirmed it is you.');

            now.mockReturnValue(Date.UTC(2026, 10, 3, 10, 5, 0));
            await confirmDeletion();

            expect(await within(section).findByRole('alert')).toHaveTextContent(
                "Your account was not deleted. Apple's confirmation lasts five minutes; continue with Apple again.",
            );
            expect(within(section).getByRole('button', { name: 'Continue with Apple' })).toBeInTheDocument();
            expect(deletionRequests(fetchMock)).toHaveLength(0);
        });

        // Apple returns only to the address registered with it, on the site's own host.
        it("sends such an account to the site's own host from another origin", async () => {
            mocks.session = signedInAs(appleUser);
            openPage('', 'https://www.magicbooklet.com');
            const fetchMock = answerRequests();
            render(<DeleteAccountPage />);

            const section = await deletionSection();
            const host = new URL(siteConfig.siteUrl).host;
            expect(within(section).getByRole('heading', { name: `Continue on ${host}` })).toBeInTheDocument();
            expect(within(section).getByRole('link', { name: `Open ${host}` })).toHaveAttribute('href', `${siteOrigin}/delete-account`);
            expect(within(section).queryByRole('button', { name: 'Continue with Apple' })).toBeNull();
            expect(within(section).queryByLabelText('Type DELETE to confirm')).toBeNull();
            expect(deletionRequests(fetchMock)).toHaveLength(0);
        });
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
