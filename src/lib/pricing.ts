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
        description: 'Perfect for trying out our service',
        features: [
            '500 Credits included',
            'Approx. 50 seconds of video',
            'Starts at 6 Credits per second cost',
            'HD quality output',
            'Download in MP4 format',
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
        description: 'Best value for content creators',
        features: [
            '2,000 Credits included',
            'Approx. 3.3 minutes of video',
            'Starts at 6 Credits per second cost',
            'HD quality output',
            'Priority processing',
            'Priority email support',
        ],
        popular: true,
    },
    {
        id: 'pro',
        name: 'Pro',
        priceUsd: 100,
        priceInr: 8300,
        credits: 10000,
        description: 'For professional creators & agencies',
        features: [
            '10,000 Credits included',
            'Approx. 16.6 minutes of video',
            'Starts at 6 Credits per second cost',
            'HD quality output',
            'Priority processing',
            'Dedicated support',
            'Commercial usage rights',
        ],
        popular: false,
    },
];

export const PRICING_PLAN_MAP = Object.fromEntries(
    PRICING_PLANS.map((plan) => [plan.id, plan])
) as Record<PricingPlanId, PricingPlan>;

