import { headers } from "next/headers";

import { resolvePricingReturnTo } from "@/app/showcase/recipe-reading";
import { loadReferralProgramTerms } from "@/lib/referral-route-service";
import { hasSupabaseAuthCookie } from "@/lib/supabase-auth-cookie";

import { PricingClient } from "./PricingClient";

export default async function Pricing({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
    // The banner prints the live Invite & Earn terms, not numbers of its own.
    const [headerStore, referralProgram, params] = await Promise.all([
        headers(),
        loadReferralProgramTerms(),
        searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>),
    ]);

    return (
        <PricingClient
            initialCountryCode={headerStore.get('x-vercel-ip-country')}
            referralProgram={referralProgram}
            // A recipe's "Buy credits" and a remix's Top up say where they were (B-F8); only a path on this site is taken back.
            returnTo={resolvePricingReturnTo(params.returnTo)}
            // The page is drawn per request, so it can see the session cookie the browser sent and
            // draw the balance card where it will be, before the browser reads the session.
            sessionCookieHint={hasSupabaseAuthCookie(headerStore.get('cookie') ?? '')}
        />
    );
}
