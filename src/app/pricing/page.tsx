import { headers } from "next/headers";

import { loadReferralProgramTerms } from "@/lib/referral-route-service";

import { PricingClient } from "./PricingClient";

export default async function Pricing() {
    // The banner prints the live Invite & Earn terms, not numbers of its own.
    const [headerStore, referralProgram] = await Promise.all([
        headers(),
        loadReferralProgramTerms(),
    ]);

    return (
        <PricingClient
            initialCountryCode={headerStore.get('x-vercel-ip-country')}
            referralProgram={referralProgram}
        />
    );
}
