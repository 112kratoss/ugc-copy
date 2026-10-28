import 'server-only';

import { unstable_cache } from 'next/cache';

import { cheapestRemixCandidate, type RemixCandidate } from '../../ugc-mobile/lib/creator-run-fit/creator-run-fit';
import { logBackendError } from '@/lib/backend-logger';
import { catalogVideoEntryFields } from '@/lib/catalog-video-entry';
import { VIDEO_MODELS } from '@/lib/client-generation-models';
import type { VideoRunMedia } from '@/lib/creator-run-inputs';
import type { CreatorStartPost, StartPostRemixForecast } from '@/lib/creator-start-posts';
import {
  fitVideoFormToModel,
  makesVideoLength,
  takesSameVideoInputs,
  videoLengthsBelow,
  videoRunOnModel,
  type VideoFormHeld,
  type VideoFormSettings,
  type VideoModelLookup,
  type VideoRegistryEntry,
  type VideoRunOnModel,
} from '@/lib/creator-video-candidates';
import {
  CatalogError,
  GENERATION_MODEL_CATALOG_DESCRIPTOR_SCHEMA_VERSION,
  type GenerationModelCatalog,
  type GenerationModelQuote,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import { loadPublishedGenerationModelCatalog, quotePublishedGenerationModels } from '@/lib/generation-model-catalog-store';
import {
  HOME_SHELF_REVALIDATE_SECONDS,
  loadHomeShelfCreationsWithPosts,
  loadSharedHomeShelfCreations,
  remixQuoteSettings,
  withoutPost,
  type HomeShelfIdentity,
  type ShelfGenerationRow,
} from '@/lib/home-shelf-server';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * Server side of the creators' "Start from a post" (`creator-start-posts.ts`): the Home
 * shelf's creations for this viewer, each video post with its remix's run priced on every
 * model the web offers. The runs are the page's own (`videoRunOnModel` over entries built
 * from the published catalog as the browser builds them), so a card's fitted price is the
 * one the page shows once the remix opens. What they cost does not depend on who asks, so
 * one build per catalog release serves every viewer; the balance is read on the page.
 */

/** Part of the cache key: bump it whenever what a build holds changes. */
const START_POST_REMIX_BUILD_VERSION = 'creator-start-post-remixes-v2';

type StoredGeneration = Pick<ShelfGenerationRow, 'id' | 'workflow_settings' | 'share_input_media_for_remix'>;

export interface StartPostRemixDependencies {
  loadGenerations: (generationIds: string[]) => Promise<StoredGeneration[]>;
  /** The published web catalog, with full descriptors (the stored schema, inputs included). */
  loadCatalog: () => Promise<GenerationModelCatalog>;
  quote: (inputs: readonly GenerationModelQuoteInput[]) => Promise<Array<PromiseSettledResult<GenerationModelQuote>>>;
}

async function loadPublishedWebCatalog() {
  const snapshot = await loadPublishedGenerationModelCatalog({
    platform: 'web',
    schemaVersion: GENERATION_MODEL_CATALOG_DESCRIPTOR_SCHEMA_VERSION,
  });
  return snapshot.catalog;
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
  loadCatalog: loadPublishedWebCatalog,
  quote: (inputs) => quotePublishedGenerationModels(inputs, { platform: 'web' }),
};

/**
 * A shelf post's remix opens without its creator's media for anyone but its creator (the
 * shelf prices only those), so the run the forecast prices holds none. Its creator gets
 * their media back, so their own cards keep the shelf's price (`loadCreatorStartPosts`).
 */
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
 * What the run holds once the remix opens: none of its creator's media, and Gemini Omni's
 * prepared voices and characters, which every remix keeps (`sanitizeWorkflowSettingsForRemix`
 * leaves them), at most three of each, as the page restores them.
 */
function heldOnRemix(stored: Record<string, unknown>): VideoFormHeld<VideoRunMedia> {
  const ids = (value: unknown) => (Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 3)
    : []);
  return { ...HOLDS_NOTHING, preparedVoiceIds: ids(stored.preparedAudioIds), characterIds: ids(stored.characterIds) };
}

/**
 * The form a remix of the post opens with, as the page sets it: each setting the run kept
 * (`fetchRemixData`), the model's first mode where it kept none, and a value the model no
 * longer offers left out, so the fitting that follows gives it the model's default, as the
 * page's own check of its settings against the model does.
 */
function restoredForm(settings: Record<string, unknown>, entry: VideoRegistryEntry): VideoFormSettings {
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const offered = (value: string | undefined, options: readonly string[]) => (value !== undefined && options.includes(value) ? value : undefined);
  const duration = typeof settings.duration === 'number' && makesVideoLength(entry, settings.duration) ? settings.duration : undefined;
  // Left undefined, a setting takes the model's default in `fitVideoFormToModel`.
  return {
    mode: text(settings.mode) ?? entry.modeOptions[0]?.value ?? '',
    aspectRatio: offered(text(settings.aspectRatio), entry.aspectRatios as readonly string[]),
    resolution: offered(text(settings.resolution), entry.resolutions as readonly string[]),
    duration,
    sound: typeof settings.sound === 'boolean' ? settings.sound : undefined,
    fixedLens: typeof settings.fixedLens === 'boolean' ? settings.fixedLens : undefined,
    isMultiShot: false,
  } as unknown as VideoFormSettings;
}

type Run = VideoRunOnModel<VideoRunMedia>;
type PlannedPost = { postId: string; held: VideoFormHeld<VideoRunMedia>; original: Run; candidates: Array<{ run: Run; takesInputs: boolean }> };

/**
 * Each run's price, by run. A run the catalog refuses (the model cannot take it) has none;
 * any other failure (the catalog unreadable or changed under the build, a price it cannot
 * work out) fails the build, so nothing half-priced is kept and the cards fall back to the
 * shelf's own prices, where the page would wait and ask again.
 */
async function pricesOf(runs: readonly Run[], quote: StartPostRemixDependencies['quote']): Promise<Map<Run, number | null>> {
  const prices = new Map<Run, number | null>();
  if (runs.length === 0) return prices;
  const answers = await quote(runs.map((run) => run.quoteInput));
  answers.forEach((answer, index) => {
    if (answer.status === 'fulfilled') {
      prices.set(runs[index], answer.value.costCredits);
      return;
    }
    const refused = answer.reason instanceof CatalogError
      && (answer.reason.code === 'INVALID_MODEL_SETTINGS' || answer.reason.code === 'MODEL_UNAVAILABLE');
    if (!refused) throw answer.reason;
    prices.set(runs[index], null);
  });
  return prices;
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
  const runOn = (modelId: string, settings: VideoFormSettings, held: VideoFormHeld<VideoRunMedia>) => videoRunOnModel({
    modelId,
    catalogRevision: catalog.revision,
    settings,
    held,
    models,
  });

  const planned = posts.flatMap((post): PlannedPost[] => {
    const generation = generationById.get(post.generationId);
    const stored = isRecord(generation?.workflow_settings) ? generation.workflow_settings : {};
    const modelId = typeof stored.model === 'string' ? stored.model.trim() : '';
    const descriptor = videoModels.find((model) => model.id === modelId);
    const entry = entries.get(modelId);
    if (!generation || !descriptor || !entry || generation.share_input_media_for_remix === true) return [];
    const visible = remixQuoteSettings(descriptor, stored);
    if (!visible || visible.isMultiShot === true) return [];

    const held = heldOnRemix(stored);
    const form = fitVideoFormToModel(modelId, restoredForm(visible, entry), models);
    const original = runOn(modelId, form, held);
    if (!original) return [];
    const candidates = videoModels.filter((model) => model.id !== modelId).flatMap((model) => {
      const run = runOn(model.id, fitVideoFormToModel(model.id, form, models), held);
      return run ? [{ run, takesInputs: takesSameVideoInputs({ inputs: original.inputs, settings: form }, run) }] : [];
    });
    return [{ postId: post.postId, held, original, candidates }];
  });

  // Every post's runs in one request; then the shorter lengths of each one's cheapest model.
  const firstPrices = await pricesOf(planned.flatMap((post) => [post.original, ...post.candidates.map((candidate) => candidate.run)]), resolved.quote);
  const priced = planned.map((post) => {
    // Only a model the run may move to can be picked (`fitRemixToBalance`), so only those are sent.
    const candidates: RemixCandidate[] = post.candidates
      .map(({ run, takesInputs }) => ({ modelId: run.modelId, cost: firstPrices.get(run) ?? null, durationSeconds: run.durationSeconds, takesInputs }))
      .filter((candidate) => candidate.takesInputs && candidate.cost !== null);
    const cheapest = cheapestRemixCandidate({ modelId: post.original.modelId, durationSeconds: post.original.durationSeconds }, candidates);
    const cheapestRun = cheapest ? post.candidates.find(({ run }) => run.modelId === cheapest.modelId)?.run : undefined;
    // The lengths the page prices, the cheapest model's under the original's.
    const shorterRuns = cheapestRun
      ? videoLengthsBelow(cheapestRun.modelId, cheapestRun.durationSeconds, models).flatMap((duration) => {
        const run = runOn(cheapestRun.modelId, { ...cheapestRun.settings, duration }, post.held);
        return run ? [run] : [];
      })
      : [];
    return { post, candidates, cheapestModelId: cheapest?.modelId ?? null, shorterRuns };
  });
  const shorterPrices = await pricesOf(priced.flatMap((post) => post.shorterRuns), resolved.quote);

  const displayName = new Map(videoModels.map((model) => [model.id, model.displayName]));
  const forecasts: Record<string, StartPostRemixForecast> = {};
  for (const { post, candidates, cheapestModelId, shorterRuns } of priced) {
    const originalCost = firstPrices.get(post.original) ?? null;
    if (originalCost === null) continue;
    forecasts[post.postId] = {
      original: { modelId: post.original.modelId, cost: originalCost, durationSeconds: post.original.durationSeconds },
      candidates,
      shorter: cheapestModelId
        ? { modelId: cheapestModelId, prices: shorterRuns.map((run) => ({ durationSeconds: run.durationSeconds, cost: shorterPrices.get(run) ?? null })) }
        : null,
      preferredModelId: catalog.defaults.video ?? null,
      modelNames: Object.fromEntries(candidates.map(({ modelId }) => [modelId, displayName.get(modelId) ?? modelId])),
    };
  }
  return forecasts;
}

/**
 * Shared by every viewer: the forecasts depend only on the posts and the catalog release,
 * and both are the key (the release's revision, read from the store's short-lived copy), so
 * a release is priced on its own and a post taken off the shelf drops out of the key. A
 * build that throws is not kept.
 */
const loadCachedStartPostRemixForecasts = unstable_cache(
  async (postsKey: string, catalogRevision: string) => {
    void catalogRevision;
    return buildStartPostRemixForecasts(JSON.parse(postsKey) as Array<{ postId: string; generationId: string }>);
  },
  [START_POST_REMIX_BUILD_VERSION],
  { revalidate: HOME_SHELF_REVALIDATE_SECONDS },
);

/** The forecasts for the shelf's shared build of video posts: none where it has none, or they cannot be built. */
async function loadStartPostRemixForecasts(): Promise<Record<string, StartPostRemixForecast>> {
  try {
    const [shelf, catalog] = await Promise.all([loadSharedHomeShelfCreations(), loadPublishedWebCatalog()]);
    const videoPosts = shelf.flatMap((creation) => (
      creation.tool === 'video' && creation.price?.kind === 'credits' && creation.post.generationId
        ? [{ postId: creation.id, generationId: creation.post.generationId }]
        : []
    ));
    return videoPosts.length > 0 ? await loadCachedStartPostRemixForecasts(JSON.stringify(videoPosts), catalog.revision) : {};
  } catch (error) {
    logBackendError('creator_start_post_remix_forecasts_failed', { error });
    return {};
  }
}

/**
 * The creators' "Start from a post" for one viewer: the shelf's creations (none where the
 * Home shelf would draw none), each video post with its remix forecast, read alongside. A
 * viewer's own post keeps the shelf's price: its remix brings their media back, which the
 * forecast does not hold. A forecast that cannot be built leaves the shelf's prices.
 */
export async function loadCreatorStartPosts(identity: HomeShelfIdentity): Promise<CreatorStartPost[]> {
  const [creations, forecasts] = await Promise.all([
    loadHomeShelfCreationsWithPosts(identity),
    loadStartPostRemixForecasts(),
  ]);
  return creations.map((creation) => ({
    ...withoutPost(creation),
    remix: creation.creator.id !== null && creation.creator.id === identity.viewerUserId ? null : forecasts[creation.id] ?? null,
  }));
}
