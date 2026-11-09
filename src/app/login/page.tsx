import LoginClient from '@/app/login/LoginClient';
import SignInWall from '@/app/login/SignInWall';
import { getSafeAuthNextPath } from '@/lib/auth-onboarding';
import { signInHalfForQuery } from '@/lib/sign-in-page';
import { loadSignInWelcomeCredits, pickSignInWallStart } from '@/lib/sign-in-page-server';

// The sign-in form posts to this page when Enter is pressed before its script has run, and
// Vercel answers a post to a prerendered page itself, with an empty 405.
export const dynamic = 'force-dynamic';

interface LoginPageProps {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

/**
 * The one sign-in page. Its query, read here so the server's HTML is the page asked for:
 * - `returnUrl`, `next` or `redirect`: where to go once signed in;
 * - `email=1` opens on the email form, and `recovery=1` too, with its notice;
 * - `mode=signup`, the invite landing's "Create new account", opens the same page: Apple and
 *   Google make the account.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
    const params = searchParams ? await searchParams : {};
    const explicitRedirect = firstParam(params.next)
        || firstParam(params.redirect)
        || firstParam(params.returnUrl);
    const recoveryRequested = firstParam(params.recovery) === '1';
    const welcomeCredits = await loadSignInWelcomeCredits();
    // Each visit starts the wall somewhere new along its loop, as each open does in the app.
    const wallStart = pickSignInWallStart();

    return (
        <LoginClient
            initialHalf={signInHalfForQuery({ email: firstParam(params.email), recovery: firstParam(params.recovery) })}
            recoveryRequested={recoveryRequested}
            redirectTo={getSafeAuthNextPath(explicitRedirect)}
            returnRequested={Boolean(explicitRedirect)}
            welcomeCredits={welcomeCredits}
            wall={<SignInWall start={wallStart} />}
        />
    );
}
