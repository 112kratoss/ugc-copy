import { describe, expect, it } from 'vitest';

import {
    CREDIT_RATE_INR,
    CREDIT_RATE_USD,
    buildScaleCosts,
    positionAgainstPeers,
    summarizeModelControls,
    toModelSlug,
    toOrdinal,
    type ModelCostEstimate,
} from '@/lib/model-pages';
import { PRICING_PLANS } from '@/lib/pricing';
import type {
    CatalogChoiceOption,
    GenerationModelDescriptor,
} from '@/lib/generation-model-catalog';

function model(overrides: Partial<GenerationModelDescriptor> = {}): GenerationModelDescriptor {
    return {
        id: 'veo-3.1',
        kind: 'video',
        displayName: 'Veo 3.1',
        description: 'A video model.',
        controls: [],
        capabilities: {},
        inputs: {},
        ...overrides,
    } as unknown as GenerationModelDescriptor;
}

function cost(credits: number): ModelCostEstimate {
    return {
        credits,
        inr: credits * CREDIT_RATE_INR,
        usd: credits * CREDIT_RATE_USD,
    };
}

describe('credit rate', () => {
    // Every pack divides to the same rate, which is what lets these pages quote
    // a currency figure without naming a pack. If a future pack breaks that,
    // the pages would be quoting one pack's rate as if it were universal.
    it('is identical across every pricing pack', () => {
        const rates = PRICING_PLANS.map((plan) => plan.priceInr / plan.credits);
        for (const rate of rates) {
            expect(rate).toBeCloseTo(CREDIT_RATE_INR, 10);
        }

        const usdRates = PRICING_PLANS.map((plan) => plan.priceUsd / plan.credits);
        for (const rate of usdRates) {
            expect(rate).toBeCloseTo(CREDIT_RATE_USD, 10);
        }
    });

    it('is derived from pricing rather than hardcoded', () => {
        expect(CREDIT_RATE_INR).toBe(PRICING_PLANS[0].priceInr / PRICING_PLANS[0].credits);
    });
});

describe('toModelSlug', () => {
    // A dot in a path segment reads as a file extension to some crawlers and
    // proxies, so version numbers are flattened.
    it('flattens version dots', () => {
        expect(toModelSlug('veo-3.1')).toBe('veo-3-1');
        expect(toModelSlug('kling-3.0-video')).toBe('kling-3-0-video');
    });

    it('leaves dotless ids alone', () => {
        expect(toModelSlug('nano-banana-pro')).toBe('nano-banana-pro');
    });

    it('produces unique slugs across a realistic id set', () => {
        const ids = ['veo-3.1', 'kling-3.0', 'kling-3.0-video', 'kling-3.0-turbo', 'z-image'];
        expect(new Set(ids.map(toModelSlug)).size).toBe(ids.length);
    });
});

describe('buildScaleCosts', () => {
    it('multiplies a single run out to a testing cycle', () => {
        const rows = buildScaleCosts(cost(30));

        expect(rows.map((row) => row.runs)).toEqual([10, 50, 100]);
        expect(rows.map((row) => row.credits)).toEqual([300, 1500, 3000]);
        expect(rows[2].inr).toBeCloseTo(3000 * CREDIT_RATE_INR, 6);
    });
});

describe('positionAgainstPeers', () => {
    const cheap = model({ id: 'cheap', displayName: 'Cheap', kind: 'video' });
    const mid = model({ id: 'mid', displayName: 'Mid', kind: 'video' });
    const dear = model({ id: 'dear', displayName: 'Dear', kind: 'video' });
    const priced = [
        { model: cheap, cost: cost(10) },
        { model: mid, cost: cost(50) },
        { model: dear, cost: cost(200) },
    ];

    it('ranks by cost per run, cheapest first', () => {
        expect(positionAgainstPeers(mid, priced)).toMatchObject({ rank: 2, total: 3 });
    });

    // The cheapest model has no cheaper peer to name, and the dearest has no
    // dearer one; naming itself would read as a bug on the page.
    it('omits the cheapest reference when this model is the cheapest', () => {
        const position = positionAgainstPeers(cheap, priced);
        expect(position?.rank).toBe(1);
        expect(position?.cheapest).toBeNull();
        expect(position?.dearest).toEqual({ name: 'Dear', credits: 200 });
    });

    it('omits the dearest reference when this model is the dearest', () => {
        const position = positionAgainstPeers(dear, priced);
        expect(position?.dearest).toBeNull();
    });

    it('ignores models of a different kind', () => {
        const imageModel = model({ id: 'img', displayName: 'Img', kind: 'image' });
        const position = positionAgainstPeers(mid, [...priced, { model: imageModel, cost: cost(1) }]);
        expect(position?.total).toBe(3);
    });

    it('returns null when there is nothing to compare against', () => {
        expect(positionAgainstPeers(cheap, [{ model: cheap, cost: cost(10) }])).toBeNull();
    });

    it('skips peers with no price rather than ranking them as free', () => {
        const unpriced = model({ id: 'unpriced', displayName: 'Unpriced', kind: 'video' });
        const position = positionAgainstPeers(mid, [...priced, { model: unpriced, cost: null }]);
        expect(position?.total).toBe(3);
    });
});

describe('toOrdinal', () => {
    it.each([
        [1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'],
        [11, '11th'], [12, '12th'], [13, '13th'],
        [21, '21st'], [22, '22nd'], [23, '23rd'], [101, '101st'],
    ])('renders %i as %s', (value, expected) => {
        expect(toOrdinal(value)).toBe(expected);
    });
});

describe('summarizeModelControls', () => {
    it('renders a choice control with its options and default', () => {
        const [summary] = summarizeModelControls(model({
            controls: [{
                key: 'resolution',
                label: 'Resolution',
                type: 'choice',
                presentation: 'chips',
                defaultValue: '720p',
                options: [
                    { value: '480p', label: '480p' },
                    { value: '720p', label: '720p' },
                ],
            }],
        } as Partial<GenerationModelDescriptor>));

        expect(summary).toEqual({
            label: 'Resolution',
            values: '480p, 720p',
            defaultValue: '720p',
        });
    });

    it('renders an integer control as a range with its unit', () => {
        const [summary] = summarizeModelControls(model({
            controls: [{
                key: 'duration',
                label: 'Duration',
                type: 'integer',
                presentation: 'stepper',
                defaultValue: 5,
                min: 4,
                max: 15,
                step: 1,
                unit: 'seconds',
            }],
        } as Partial<GenerationModelDescriptor>));

        expect(summary).toEqual({
            label: 'Duration',
            values: '4–15 seconds',
            defaultValue: '5 seconds',
        });
    });

    it('skips a choice control that offers nothing', () => {
        expect(summarizeModelControls(model({
            controls: [{
                key: 'empty',
                label: 'Empty',
                type: 'choice',
                presentation: 'chips',
                defaultValue: '',
                options: [] as CatalogChoiceOption[],
            }],
        } as Partial<GenerationModelDescriptor>))).toEqual([]);
    });
});
