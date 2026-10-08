export type PricingPlanId = 'starter' | 'creator' | 'pro';

export interface PricingPlan {
    id: PricingPlanId;
    name: string;
    priceUsd: number;
    priceInr: number;
    credits: number;
    description: string;
    features: string[];
    popular: boolean;
}

export const PRICING_CURRENCY = 'INR';

export const PRICING_PLANS: PricingPlan[] = [
    {
        id: 'starter',
        name: 'Starter',
        priceUsd: 5,
        priceInr: 415,
        credits: 500,
        description: 'Enough to try image, video, and motion.',
        features: [
            '500 Credits included',
            'Generation cost shown before every run',
            'Rates vary by model, quality, and duration',
            'HD quality output',
            'Email support',
        ],
        popular: false,
    },
    {
        id: 'creator',
        name: 'Creator',
        priceUsd: 20,
        priceInr: 1660,
        credits: 2000,
        description: 'Best value for active creators.',
        features: [
            '2,000 Credits included',
            'Generation cost shown before every run',
            'Rates vary by model, quality, and duration',
            'HD quality output',
            'Email support',
        ],
        popular: true,
    },
    {
        id: 'pro',
        name: 'Pro',
        priceUsd: 100,
        priceInr: 8300,
        credits: 10000,
        description: 'For pro creators and small teams producing daily.',
        features: [
            '10,000 Credits included',
            'Generation cost shown before every run',
            'Rates vary by model, quality, and duration',
            'HD quality output',
            'Email support',
        ],
        popular: false,
    },
];

export const PRICING_PLAN_MAP = Object.fromEntries(
    PRICING_PLANS.map((plan) => [plan.id, plan])
) as Record<PricingPlanId, PricingPlan>;
