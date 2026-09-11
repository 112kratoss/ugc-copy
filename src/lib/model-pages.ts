import 'server-only';

import { PHASE_PRODUCTION_BUILD } from 'next/constants';

import { logBackendError, logBackendWarning } from '@/lib/backend-logger';
import {
    GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
    type GenerationModelDescriptor,
    type GenerationModelKind,
} from '@/lib/generation-model-catalog';
import {
    loadPublishedGenerationModelCatalog,
    quotePublishedGenerationModel,
} from '@/lib/generation-model-catalog-store';
import { PRICING_PLANS } from '@/lib/pricing';

/**
 * Public reference pages for the generation catalog.
 *
 * The catalog is the one thing this product can publish that competitors
 * cannot: a real per-generation cost for every model it runs. Everyone else in
 * the category quotes a monthly subscription, which answers a different
 * question than "what does one more video cost me". These pages exist to answer
 * that, and they regenerate from the catalog rather than being hand-maintained,
 * so adding a model adds a page.
 *
 * Everything reads through the catalog *store*, not the code catalog directly:
 * production publishes model definitions and pricing from the database
 * (`GENERATION_MODEL_CATALOG_SOURCE=database`), so building these pages off
 * `buildGenerationModelCatalog` would publish whatever the last deploy happened
 * to compile rather than what the product is currently charging.
 */

/**
 * Credit packs are priced at a single flat rate — 500/₹415, 2000/₹1660 and
 * 10000/₹8300 all divide to the same number — so a credit cost converts to
 * currency without needing to name a pack. Derived rather than hardcoded so a
 * pricing change cannot leave these pages quoting a stale rate.
 */
const referencePlan = PRICING_PLANS[0];
export const CREDIT_RATE_INR = referencePlan.priceInr / referencePlan.credits;
export const CREDIT_RATE_USD = referencePlan.priceUsd / referencePlan.credits;

/** Dots are legal in a path segment but read as a file extension. */
export function toModelSlug(modelId: string): string {
    return modelId.replace(/\./g, '-');
}

export async function listPublicModels(): Promise<GenerationModelDescriptor[]> {
    const snapshot = await loadPublishedGenerationModelCatalog({
        platform: 'web',
        schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
    });
    return snapshot.catalog.models;
}

/**
 * `listPublicModels` for a page the build prerenders.
 *
 * `/models` is a static route with `revalidate`, so `next build` renders it
 * once, and a build may have no database: CI's points at a placeholder Supabase
 * URL, where the uncaught load failure failed the whole build. Only there is it
 * tolerated, by rendering an empty index. Production builds reach the database
 * and prerender the real list. At request time the failure is rethrown, so ISR
 * keeps serving the last good page instead of caching an empty one.
 */
export async function listPublicModelsForPrerender(): Promise<GenerationModelDescriptor[]> {
    try {
        return await listPublicModels();
    } catch (error) {
        if (process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD) {
            throw error;
        }
        logBackendWarning('models_index_prerendered_without_catalog', { error });
        return [];
    }
}

export async function findModelBySlug(slug: string): Promise<GenerationModelDescriptor | null> {
    const models = await listPublicModels();
    return models.find((model) => toModelSlug(model.id) === slug) ?? null;
}

export const MODEL_KIND_LABELS: Record<GenerationModelKind, string> = {
    image: 'AI image generation',
    video: 'AI video generation',
    motion: 'AI motion transfer',
};

export const MODEL_KIND_NOUNS: Record<GenerationModelKind, string> = {
    image: 'image',
    video: 'video',
    motion: 'motion transfer',
};

/** Where the studio opens for each kind. */
export const MODEL_KIND_CREATE_PATHS: Record<GenerationModelKind, string> = {
    image: '/create-image',
    video: '/create-video',
    motion: '/create-motion',
};

/** The feature page each kind belongs to, for cluster linking. */
export const MODEL_KIND_FEATURE_PATHS: Record<GenerationModelKind, string> = {
    image: '/ai-image-generator',
    video: '/ai-video-generator',
    motion: '/ai-motion-transfer',
};

type BaselineInputCounts = {
    images: number;
    videos: number;
    audios: number;
    preparedAudios: number;
    characters: number;
};

/**
 * Candidate input shapes, simplest first.
 *
 * A model's settings can be conditional on which inputs are present — supplying
 * a character reference, for instance, can put a model into a mode where one of
 * its own default settings is no longer offered, and the quote is then rejected
 * for a combination no user would ever assemble. Rather than encode which model
 * behaves which way, try the plain shapes in order and take the first that
 * quotes. A motion model needs its reference video, so that shape is included
 * for any model that declares one.
 */
function baselineInputCandidates(model: GenerationModelDescriptor): BaselineInputCounts[] {
    const empty: BaselineInputCounts = {
        images: 0,
        videos: 0,
        audios: 0,
        preparedAudios: 0,
        characters: 0,
    };
    const candidates: BaselineInputCounts[] = [empty];

    if (model.inputs.imageReferences || model.inputs.startFrame) {
        candidates.push({ ...empty, images: 1 });
    }
    if (model.inputs.videoReferences) {
        candidates.push({ ...empty, videos: 1 });
        candidates.push({ ...empty, images: 1, videos: 1 });
    }
    if (model.inputs.characterReferences) {
        candidates.push({ ...empty, characters: 1 });
    }

    return candidates;
}

export type ModelCostEstimate = {
    credits: number;
    inr: number;
    usd: number;
};

/**
 * The cost of one generation at the model's own default settings.
 *
 * The quote engine validates strictly and throws on any combination it will not
 * run — which is correct for a real generation and unhelpful for a reference
 * page. A model whose required inputs cannot be guessed here simply publishes
 * without a price rather than with a wrong one; the studio still shows the real
 * cost before anyone spends anything.
 */
export async function getBaselineCost(
    model: GenerationModelDescriptor
): Promise<ModelCostEstimate | null> {
    for (const inputCounts of baselineInputCandidates(model)) {
        try {
            const quote = await quotePublishedGenerationModel({
                kind: model.kind,
                modelId: model.id,
                schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
                settings: {},
                inputCounts,
            }, { platform: 'web' });

            if (!Number.isFinite(quote.costCredits) || quote.costCredits <= 0) {
                continue;
            }

            return {
                credits: quote.costCredits,
                inr: quote.costCredits * CREDIT_RATE_INR,
                usd: quote.costCredits * CREDIT_RATE_USD,
            };
        } catch {
            // This shape is not runnable for this model; try the next one.
        }
    }

    // Every candidate was rejected. A model publishes without a price rather
    // than with a wrong one — the studio still shows the real cost before
    // anyone spends anything. Logged so a catalog change that breaks quoting
    // across the board is visible rather than silently blanking these pages.
    logBackendError('model_page_baseline_quote_unavailable', { modelId: model.id });
    return null;
}

/**
 * Capability lines for a model, phrased for someone deciding whether it fits
 * their work rather than for someone reading an API reference.
 */
export function describeModelCapabilities(model: GenerationModelDescriptor): string[] {
    const lines: string[] = [];

    if (model.capabilities.multiShot) {
        lines.push('Multi-shot prompts — describe a sequence of shots in one generation.');
    }
    if (model.capabilities.sound) {
        lines.push('Generates audio alongside the video.');
    }
    if (model.capabilities.fixedLens) {
        lines.push('Fixed lens, so framing stays put instead of drifting between runs.');
    }
    if (model.inputs.startFrame) {
        lines.push('Accepts a start frame, which pins the opening composition far more reliably than a text prompt.');
    }
    if (model.inputs.endFrame) {
        lines.push('Accepts an end frame, so you control where the motion resolves.');
    }
    if (model.inputs.imageReferences) {
        const max = model.inputs.imageReferences.max;
        lines.push(`Takes up to ${max} reference image${max === 1 ? '' : 's'} to steer subject and style.`);
    }
    if (model.inputs.videoReferences) {
        lines.push('Takes a reference video — the performance it transfers onto your subject.');
    }
    if (model.inputs.characterReferences) {
        lines.push('Takes a character reference, holding one persona consistent across generations.');
    }
    if (model.capabilities.outputFormat) {
        lines.push('Output format is selectable.');
    }

    return lines;
}

export type ModelControlSummary = {
    label: string;
    values: string;
    defaultValue: string | null;
};

/**
 * The settings a model exposes, rendered as reference rows.
 *
 * This is the other half of the proprietary data on these pages: the exact
 * resolutions, durations, and aspect ratios each model accepts. It comes
 * straight from the catalog the studio validates against, so it cannot drift
 * from what the product will actually run.
 */
export function summarizeModelControls(model: GenerationModelDescriptor): ModelControlSummary[] {
    const summaries: ModelControlSummary[] = [];

    for (const control of model.controls) {
        if (control.type === 'choice') {
            const options = control.options.map((option) => option.label);
            if (options.length === 0) continue;
            summaries.push({
                label: control.label,
                values: options.join(', '),
                defaultValue: control.options.find(
                    (option) => option.value === control.defaultValue
                )?.label ?? null,
            });
            continue;
        }

        if (control.type === 'integer') {
            const unit = control.unit ? ` ${control.unit}` : '';
            summaries.push({
                label: control.label,
                values: `${control.min}–${control.max}${unit}`,
                defaultValue: `${control.defaultValue}${unit}`,
            });
            continue;
        }

        summaries.push({
            label: control.label,
            values: 'On or off',
            defaultValue: control.defaultValue ? 'On' : 'Off',
        });
    }

    return summaries;
}

/** Credits rendered with the currency conversions people actually compare. */
export function formatCost(cost: ModelCostEstimate): string {
    return `${cost.credits} credits (about ₹${cost.inr.toFixed(2)} / $${cost.usd.toFixed(2)})`;
}

/**
 * Guidance per generation kind.
 *
 * The catalog knows what a model *can* do; it has no opinion on when to reach
 * for one. These paragraphs carry that, and they are keyed by kind rather than
 * written per model so a newly published model inherits them instead of
 * shipping a page with nothing on it but a price.
 */
export const MODEL_KIND_GUIDANCE: Record<GenerationModelKind, {
    goodFor: string[];
    poorFor: string[];
    note: string;
}> = {
    video: {
        goodFor: [
            'Staged product scenes — the product being used, poured, opened, worn.',
            'Testing narrative structure before committing production budget.',
            'B-roll and establishing shots that would otherwise need a location.',
            'Multi-shot concepts where the sequence itself is what you are testing.',
        ],
        poorFor: [
            'A recurring presenter who must be the same person in every ad — every generation invents the subject anew.',
            'Legible on-pack text or logos, which most video models render poorly.',
            'Exact reproduction of your packaging from a text description alone.',
        ],
        note: 'Supply a start frame rather than describing composition in prose. A reference image pins the opening far more reliably than any wording, and it is the only dependable way to keep specific packaging recognisable.',
    },
    image: {
        goodFor: [
            'Hook frames and concept stills for comparing ad openings.',
            'Background and setting tests, which drive perceived authenticity more than most teams expect.',
            'Reference frames that steer a later video generation.',
            'Clean, front-facing persona stills built to be animated by motion transfer.',
        ],
        poorFor: [
            'Small typography on packaging, which most image models garble.',
            'Finished hero creative where brand judgement and craft carry the work.',
        ],
        note: 'Describe the photograph rather than the product — light, surface, camera distance, mood. Naming only the subject leaves every photographic decision to the model, which is why output varies so much run to run.',
    },
    motion: {
        goodFor: [
            'Talking-head explainers and direct-response hooks.',
            'One persona held constant across an entire campaign.',
            'Re-running an existing persona against a new script without a reshoot.',
            'Multilingual variants delivered by the same on-screen face.',
        ],
        poorFor: [
            'Any creative where the persona must physically interact with the product.',
            'Scenes requiring staging, movement through a space, or choreography.',
            'Claims of genuine customer testimony — an AI presenter making factual claims needs clear disclosure.',
        ],
        note: 'The reference performance matters more than the prompt. It carries timing, emphasis and micro-expression directly, so a flat or rushed reference produces a flat or rushed ad no matter how good the source image is.',
    },
};

export type ScaleCostRow = {
    runs: number;
    credits: number;
    inr: number;
};

/**
 * What a batch costs.
 *
 * "What does one generation cost" is the question that gets asked; "what does a
 * week of creative testing cost" is the one being asked underneath it. Ten,
 * fifty and a hundred runs bracket a realistic testing cycle.
 */
export function buildScaleCosts(cost: ModelCostEstimate): ScaleCostRow[] {
    return [10, 50, 100].map((runs) => ({
        runs,
        credits: cost.credits * runs,
        inr: cost.credits * runs * CREDIT_RATE_INR,
    }));
}

export type PeerPosition = {
    rank: number;
    total: number;
    cheapest: { name: string; credits: number } | null;
    dearest: { name: string; credits: number } | null;
};

/**
 * Where this model sits on cost among the others of its kind. Concrete
 * positioning a buyer can act on, and it stays true as the catalog changes
 * because it is computed rather than written down.
 */
export function positionAgainstPeers(
    model: GenerationModelDescriptor,
    priced: Array<{ model: GenerationModelDescriptor; cost: ModelCostEstimate | null }>
): PeerPosition | null {
    const peers = priced
        .filter((entry) => entry.model.kind === model.kind && entry.cost)
        .map((entry) => ({ model: entry.model, credits: entry.cost!.credits }))
        .sort((left, right) => left.credits - right.credits);

    if (peers.length < 2) {
        return null;
    }

    const index = peers.findIndex((peer) => peer.model.id === model.id);
    if (index === -1) {
        return null;
    }

    return {
        rank: index + 1,
        total: peers.length,
        cheapest: peers[0].model.id === model.id
            ? null
            : { name: peers[0].model.displayName, credits: peers[0].credits },
        dearest: peers[peers.length - 1].model.id === model.id
            ? null
            : { name: peers[peers.length - 1].model.displayName, credits: peers[peers.length - 1].credits },
    };
}

/** "1st", "2nd", "3rd", "11th" — English ordinals, including the teens. */
export function toOrdinal(value: number): string {
    const lastTwo = value % 100;
    if (lastTwo >= 11 && lastTwo <= 13) {
        return `${value}th`;
    }

    switch (value % 10) {
        case 1: return `${value}st`;
        case 2: return `${value}nd`;
        case 3: return `${value}rd`;
        default: return `${value}th`;
    }
}
