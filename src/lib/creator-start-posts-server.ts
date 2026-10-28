import 'server-only';

import { unstable_cache } from 'next/cache';

import { cheapestRemixCandidate, type RemixCandidate } from '../../ugc-mobile/lib/creator-run-fit/creator-run-fit';
import { logBackendError } from '@/lib/backend-logger';
import { catalogVideoEntryFields } from '@/lib/catalog-video-entry';
import { VIDEO_MODELS, videoLengthOptions } from '@/lib/client-generation-models';
import type { VideoRunMedia } from '@/lib/creator-run-inputs';
import type { CreatorStartPost, StartPostRemixForecast } from '@/lib/creator-start-posts';
import {
  fitVideoFormToModel,
  takesSameVideoInputs,
  videoRunOnModel,
  type VideoFormHeld,
  type VideoFormSettings,
  type VideoModelLookup,
  type VideoRegistryEntry,
  type VideoRunOnModel,
} from '@/lib/creator-video-candidates';
import {
  GENERATION_MODEL_CATALOG_DESCRIPTOR_SCHEMA_VERSION,
  type GenerationModelCatalog,
  type GenerationModelQuote,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import { loadPublishedGenerationModelCatalog, quotePublishedGenerationModels } from '@/lib/generation-model-catalog-store';
import { loadHomeShelfCreationsWithPosts, remixQuoteSettings, type HomeShelfIdentity } from '@/lib/home-shelf-server';
import { createServiceClient } from '@/lib/server-helpers';
import { SHOWCASE_FEED_CACHE_TAG } from '@/lib/showcase-feed-cache';

/**
 * Server side of the creators' "Start from a post" (`creator-start-posts.ts`): the Home
 * shelf's creations for this viewer, each video post with its remix's run priced on every
 * model the web offers. The runs are the page's own (`videoRunOnModel` over entries built
 * from the published catalog as the browser builds them), so a card's fitted price is the
 * one the page shows once the remix opens. What they cost does not depend on who asks, so
 * one build serves every viewer between rebuilds; the balance is read on the page.
 */

/** How long a build of the forecasts is reused, as the shelf's own. */
const START_POST_REMIX_REVALIDATE_SECONDS = 300;

/** Part of the cache key: bump it whenever what a build holds changes. */
const START_POST_REMIX_BUILD_VERSION = 'creator-start-post-remixes-v1';

interface StoredGeneration {
  id: string;
  workflow_settings: Record<string, unknown> | null;
  share_input_media_for_remix: boolean | null;
}

export interface StartPostRemixDependencies {
  loadGenerations: (generationIds: string[]) => Promise<StoredGeneration[]>;
  /** The published web catalog, with full descriptors (the stored schema, inputs included). */
  loadCatalog: () => Promise<GenerationModelCatalog>;
  quote: (inputs: readonly GenerationModelQuoteInput[]) => Promise<Array<PromiseSettledResult<GenerationModelQuote>>>;
}

const defaultDependencies: StartPostRemixDependencies = {
  async loadGenerations(generationIds) {
    const { data, error } = await createServiceClient()
      .from('generations')
      .select('id, workflow_settings, share_input_media_for_remix')
      .in('id', generationIds);
    if (error) throw error;
    return (data ?? []) as StoredGeneration[];
  },
  async loadCatalog() {
    const snapshot = await loadPublishedGenerationModelCatalog({
      platform: 'web',
      schemaVersion: GENERATION_MODEL_CATALOG_DESCRIPTOR_SCHEMA_VERSION,
    });
    return snapshot.catalog;
  },
  quote: (inputs) => quotePublishedGenerationModels(inputs, { platform: 'web' }),
};

/** A shelf post's remix opens without its creator's media (the shelf prices only those), so its run holds nothing. */
const HOLDS_NOTHING: VideoFormHeld<VideoRunMedia> = {
  imageReferences: [],
  videoReferences: [],
  audioReferences: [],
  videoElements: [],
  subjects: [],
  hasStartFrame: false,
  hasEndFrame: false,
  preparedVoiceIds: [],
  characterIds: [],
  multiShotSeconds: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The form a remix of the post opens with, as the page restores it (`fetchRemixData`):
 * each setting the run kept, the model's first mode where it kept none; the rest is left
 * to the model's defaults by the fitting that follows.
 */
function restoredForm(settings: Record<string, unknown>, entry: VideoRegistryEntry): VideoFormSettings {
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  return {
    mode: text(settings.mode) ?? entry.modeOptions[0]?.value ?? '',
    aspectRatio: text(settings.aspectRatio),
    resolution: text(settings.resolution),
    duration: typeof settings.duration === 'number' && settings.duration > 0 ? settings.duration : undefined,
    sound: typeof settings.sound === 'boolean' ? settings.sound : undefined,
    fixedLens: typeof settings.fixedLens === 'boolean' ? settings.fixedLens : undefined,
    isMultiShot: false,
  } as unknown as VideoFormSettings;
}

function durationRangeOf(entry: VideoRegistryEntry | undefined) {
  return entry && 'singleShotDurationRange' in entry ? entry.singleShotDurationRange : null;
}

type PlannedPost = {
  postId: string;
  form: VideoFormSettings;
  original: VideoRunOnModel<VideoRunMedia>;
  candidates: Array<{ run: VideoRunOnModel<VideoRunMedia>; takesInputs: boolean }>;
};

async function costsOf(
  runs: readonly VideoRunOnModel<VideoRunMedia>[],
  quote: StartPostRemixDependencies['quote'],
): Promise<Array<number | null>> {
  if (runs.length === 0) return [];
  const answers = await quote(runs.map((run) => run.quoteInput));
  return answers.map((answer) => (answer.status === 'fulfilled' ? answer.value.costCredits : null));
}

/**
 * Each video post's remix priced on every model (`StartPostRemixForecast`), by post id. A
 * post whose run cannot be read as the page reads it (shared media, which the page brings
 * and prices; a multi-shot run; a model the web no longer offers; an original the catalog
 * will not price) has none, and its card keeps the shelf's own price.
 */
export async function buildStartPostRemixForecasts(
  posts: ReadonlyArray<{ postId: string; generationId: string }>,
  dependencies: Partial<StartPostRemixDependencies> = {},
): Promise<Record<string, StartPostRemixForecast>> {
  if (posts.length === 0) return {};
  const resolved = { ...defaultDependencies, ...dependencies };
  const [generations, catalog] = await Promise.all([
    resolved.loadGenerations(posts.map((post) => post.generationId)),
    resolved.loadCatalog(),
  ]);
  const videoModels = catalog.models.filter((model) => model.kind === 'video');
  const entries = new Map(videoModels.map((model) => [model.id, {
    ...((VIDEO_MODELS as unknown as Record<string, object | undefined>)[model.id] ?? {}),
    ...catalogVideoEntryFields(model),
  } as unknown as VideoRegistryEntry]));
  const models: VideoModelLookup = (modelId) => entries.get(modelId);
  const generationById = new Map(generations.map((generation) => [generation.id, generation]));

  const planned = posts.flatMap((post): PlannedPost[] => {
    const generation = generationById.get(post.generationId);
    const stored = isRecord(generation?.workflow_settings) ? generation.workflow_settings : {};
    const modelId = typeof stored.model === 'string' ? stored.model.trim() : '';
    const descriptor = videoModels.find((model) => model.id === modelId);
    const entry = entries.get(modelId);
    if (!generation || !descriptor || !entry || generation.share_input_media_for_remix === true) return [];
    const visible = remixQuoteSettings(descriptor, stored);
    if (!visible || visible.isMultiShot === true) return [];

    const form = fitVideoFormToModel(modelId, restoredForm(visible, entry), models);
    const original = videoRunOnModel({ modelId, catalogRevision: catalog.revision, settings: form, held: HOLDS_NOTHING, models });
    if (!original) return [];
    const candidates = videoModels.filter((model) => model.id !== modelId).flatMap((model) => {
      const run = videoRunOnModel({
        modelId: model.id,
        catalogRevision: catalog.revision,
        settings: fitVideoFormToModel(model.id, form, models),
        held: HOLDS_NOTHING,
        models,
      });
      return run ? [{ run, takesInputs: takesSameVideoInputs({ inputs: original.inputs, settings: form }, run) }] : [];
    });
    return [{ postId: post.postId, form, original, candidates }];
  });

  // Every post's runs in one request; then the shorter lengths of each one's cheapest model.
  const firstRuns = planned.flatMap((post) => [post.original, ...post.candidates.map((candidate) => candidate.run)]);
  const firstCosts = await costsOf(firstRuns, resolved.quote);
  let offset = 0;
  const priced = planned.map((post) => {
    const originalCost = firstCosts[offset] ?? null;
    const candidates: RemixCandidate[] = post.candidates.map((candidate, index) => ({
      modelId: candidate.run.modelId,
      cost: firstCosts[offset + 1 + index] ?? null,
      durationSeconds: candidate.run.durationSeconds,
      takesInputs: candidate.takesInputs,
    }));
    offset += 1 + post.candidates.length;
    const cheapest = cheapestRemixCandidate(
      { modelId: post.original.modelId, durationSeconds: post.original.durationSeconds },
      candidates,
    );
    const cheapestRun = cheapest ? post.candidates.find((candidate) => candidate.run.modelId === cheapest.modelId)?.run : undefined;
    const entry = cheapest ? entries.get(cheapest.modelId) : undefined;
    const shorterRuns = cheapestRun && entry
      ? videoLengthOptions(durationRangeOf(entry), entry.durations)
        .filter((length) => length < cheapestRun.durationSeconds)
        .flatMap((duration) => {
          const run = videoRunOnModel({
            modelId: cheapestRun.modelId,
            catalogRevision: catalog.revision,
            settings: { ...cheapestRun.settings, duration },
            held: HOLDS_NOTHING,
            models,
          });
          return run ? [run] : [];
        })
      : [];
    return { post, originalCost, candidates, cheapestModelId: cheapest?.modelId ?? null, shorterRuns };
  });

  const secondCosts = await costsOf(priced.flatMap((post) => post.shorterRuns), resolved.quote);
  offset = 0;
  const forecasts: Record<string, StartPostRemixForecast> = {};
  for (const { post, originalCost, candidates, cheapestModelId, shorterRuns } of priced) {
    const shorterPrices = shorterRuns.map((run, index) => ({ durationSeconds: run.durationSeconds, cost: secondCosts[offset + index] ?? null }));
    offset += shorterRuns.length;
    if (originalCost === null) continue;
    forecasts[post.postId] = {
      original: { modelId: post.original.modelId, cost: originalCost, durationSeconds: post.original.durationSeconds },
      candidates,
      shorter: cheapestModelId ? { modelId: cheapestModelId, prices: shorterPrices } : null,
      preferredModelId: catalog.defaults.video ?? null,
      modelNames: Object.fromEntries(videoModels.map((model) => [model.id, model.displayName])),
    };
  }
  return forecasts;
}

/**
 * Shared by every viewer: the forecasts depend only on the posts and the catalog. The
 * posts are the key, and the build carries the feed's tag, so a post taken down leaves
 * with the shelf's own build. A build that throws is not kept.
 */
const loadCachedStartPostRemixForecasts = unstable_cache(
  async (postsKey: string) => buildStartPostRemixForecasts(JSON.parse(postsKey) as Array<{ postId: string; generationId: string }>),
  [START_POST_REMIX_BUILD_VERSION],
  { revalidate: START_POST_REMIX_REVALIDATE_SECONDS, tags: [SHOWCASE_FEED_CACHE_TAG] },
);

/**
 * The creators' "Start from a post" for one viewer: the shelf's creations (none where the
 * Home shelf would draw none), each video post with its remix forecast. A forecast that
 * cannot be built leaves the cards on the shelf's own prices.
 */
export async function loadCreatorStartPosts(identity: HomeShelfIdentity): Promise<CreatorStartPost[]> {
  const creations = await loadHomeShelfCreationsWithPosts(identity);
  const videoPosts = creations.flatMap((creation) => (
    creation.tool === 'video' && creation.price?.kind === 'credits' && creation.post.generationId
      ? [{ postId: creation.id, generationId: creation.post.generationId }]
      : []
  ));
  let forecasts: Record<string, StartPostRemixForecast> = {};
  if (videoPosts.length > 0) {
    try {
      forecasts = await loadCachedStartPostRemixForecasts(JSON.stringify(videoPosts));
    } catch (error) {
      logBackendError('creator_start_post_remix_forecasts_failed', { error });
    }
  }
  return creations.map(({ post, ...creation }) => {
    void post;
    return { ...creation, remix: forecasts[creation.id] ?? null };
  });
}
