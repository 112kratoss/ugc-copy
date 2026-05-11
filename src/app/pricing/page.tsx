import { headers } from "next/headers";

import { PricingClient } from "./PricingClient";

export default async function Pricing() {
    const headerStore = await headers();

    return (
        <PricingClient initialCountryCode={headerStore.get('x-vercel-ip-country')} />
    );
}
