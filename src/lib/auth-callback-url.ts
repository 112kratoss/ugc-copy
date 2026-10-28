/**
 * Where a provider sign-in (Google) sends the browser back to: `/auth/callback`
 * on the configured origin, which finishes the sign-in and goes on to `next`.
 * Shared by the login page and the creators' sign-up sheet.
 */
function getConfiguredAuthOrigin() {
    const configuredOrigin =
        process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN ||
        process.env.NEXT_PUBLIC_SITE_URL;

    if (configuredOrigin) {
        try {
            const parsed = new URL(configuredOrigin);
            const isSecure = parsed.protocol === 'https:';
            const isLocal =
                parsed.protocol === 'http:' &&
                (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');

            if (isSecure || isLocal) {
                return parsed.origin;
            }
        } catch {
            // Fall through to the active browser origin.
        }
    }

    return window.location.origin;
}

export function getAuthCallbackUrl(nextPath: string) {
    return `${getConfiguredAuthOrigin()}/auth/callback?next=${encodeURIComponent(nextPath)}`;
}
