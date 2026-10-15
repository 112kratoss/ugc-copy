import creditPacksContract from '../../contracts/credit-packs-v1.json';

export type PricingPlanId = 'starter' | 'creator' | 'pro';

export interface PricingPlan {
    id: PricingPlanId;
    name: string;
    priceUsd: number;
    priceInr: number;
    credits: number;
    description: string;
    features: string[];
    /** The label of the pack both clients feature, or null. */
    badge: string | null;
    popular: boolean;
    /** The App Store and Google Play product that sells this pack. */
    mobileProductId: string;
}

export const PRICING_CURRENCY = 'INR';

// The web's reference prices for its currency estimate; checkout always charges
// priceInr, and the app shows the store's own price.
const WEB_PRICE_USD: Record<PricingPlanId, number> = {
    starter: 5,
    creator: 20,
    pro: 100,
};

// No "HD quality output": several models offer 480p.
const SHARED_FEATURES = [
    'Generation cost shown before every run',
    'Rates vary by model, quality, and duration',
    'Email support',
];

function isPricingPlanId(value: string): value is PricingPlanId {
    return Object.hasOwn(WEB_PRICE_USD, value);
}

/**
 * The packs as contracts/credit-packs-v1.json defines them. The web list, the
 * Razorpay order amount and the mobile settlement all read these, so the credits
 * the app says a pack holds are the credits the server grants.
 */
export const PRICING_PLANS: PricingPlan[] = creditPacksContract.packs.map((pack) => {
    if (!isPricingPlanId(pack.id)) {
        throw new Error(`contracts/credit-packs-v1.json names a pack this build cannot sell: ${pack.id}`);
    }

    return {
        id: pack.id,
        name: pack.name,
        priceUsd: WEB_PRICE_USD[pack.id],
        priceInr: pack.priceInr,
        credits: pack.credits,
        description: pack.description,
        features: [`${pack.credits.toLocaleString('en-US')} Credits included`, ...SHARED_FEATURES],
        badge: pack.badge,
        popular: pack.badge !== null,
        mobileProductId: pack.mobileProductId,
    };
});

export const PRICING_PLAN_MAP = Object.fromEntries(
    PRICING_PLANS.map((plan) => [plan.id, plan])
) as Record<PricingPlanId, PricingPlan>;
