import 'server-only';

import { unstable_cache } from 'next/cache';

import { logBackendError } from '@/lib/backend-logger';
import {
  GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  type GenerationModelDescriptor,
} from '@/lib/generation-model-catalog';
import {
  loadPublishedGenerationModelCatalog,
  quotePublishedGenerationModel,
} from '@/lib/generation-model-catalog-store';
import { sanitizeWorkflowSettingsForRemix } from '@/lib/generation-input-media';
import type { FeedViewerRelations } from '@/lib/feed-visibility';
import {
  HOME_SHELF_MIN_CREATIONS,
  arrangeHomeShelf,
  selectHomeShelfActions,
  toHomeShelfCreation,
  type HomeShelfAction,
  type HomeShelfCreation,
  type HomeShelfItem,
  type HomeShelfPin,
  type HomeShelfPrice,
} from '@/lib/home-shelf';
import { HOME_SHELF_EARN_CARD_ENABLED, HOME_SHELF_PINS } from '@/lib/home-shelf-lineup';
import { POST_RESOURCE_CREATOR_SHARE_PERCENT } from '@/lib/post-resource-commerce';
import { loadReferralProgramTerms } from '@/lib/referral-route-service';
import { createServiceClient } from '@/lib/server-helpers';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import { getShowcaseFeedItemsByPostIds } from '@/lib/showcase-feed';
import { SHOWCASE_FEED_CACHE_TAG } from '@/lib/showcase-feed-cache';
import { loadViewerRelations } from '@/lib/showcase-feed-personalization';
import { loadWelcomeCreditAmount } from '@/lib/welcome-credit-program-server';

/**
 * Server side of the "Make this" shelf (`home-shelf.ts`): reads the pinned
 * posts, prices each one the way its creator page will, and works out which
 * action cards a viewer is offered. The web pages' loader degrades to an empty
 * shelf instead of throwing, as the other home loaders do: Home renders
 * without it. The app's loader throws instead, so the route answers an error
 * that neither the edge nor the app keeps, rather than an empty shelf both do.
 */

/** How long a built shelf is reused between rebuilds. */
export const HOME_SHELF_REVALIDATE_SECONDS = 300;

/**
 * Part of the build's cache key. The Data Cache outlives a deploy, so bump this
 * whenever what a build holds or which posts it lets in changes.
 */
const HOME_SHELF_BUILD_VERSION = 'home-shelf-creations-v4';

/** The shelf could not be read, or not filtered for its viewer; the app's route answers an error. */
export class HomeShelfUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HomeShelfUnavailableError';
  }
}

type FailureMode = 'empty' | 'throw';

/**
 * Who asked. No id is a signed-out visitor; a guest's id is read for its
 * blocks and feed choices but offered what a signed-out visitor is.
 */
export interface HomeShelfIdentity {
  viewerUserId: string | null;
  isAnonymous: boolean;
}

const SIGNED_OUT: HomeShelfIdentity = { viewerUserId: null, isAnonymous: false };

/** A creation card with the post it came from: the app's remix flow takes the post itself. */
export type HomeShelfCreationWithPost = HomeShelfCreation & { post: ShowcaseFeedItem };

/** What `/api/home/shelf` sends per item: creations carry their post for the app. */
export type HomeShelfApiItem = HomeShelfCreationWithPost | HomeShelfAction;

export interface ShelfGenerationRow {
  id: string;
  model: string | null;
  workflow_settings: Record<string, unknown> | null;
  share_input_media_for_remix: boolean | null;
}

/** The published catalogs a card's model must be in: the web's and the app's. */
interface ShelfCatalogs {
  web: GenerationModelDescriptor[];
  mobile: GenerationModelDescriptor[];
}

export interface HomeShelfCreationDependencies {
  getPosts: (postIds: string[]) => Promise<ShowcaseFeedItem[]>;
  loadGenerations: (generationIds: string[]) => Promise<ShelfGenerationRow[]>;
  /**
   * Of these posts, those whose published recipe hands the creation's inputs to whoever
   * unlocks it: its stored remix switch, which `loadGenerationRecipeRemixInputMediaByPostId`
   * reads. The feed's `asset.allowRemix` cannot say so: it is on for every published recipe of
   * a creation (`get_public_post_resource_bundle_summaries`).
   */
  loadRecipeHandovers: (postIds: string[]) => Promise<ReadonlySet<string>>;
  loadCatalogs: () => Promise<ShelfCatalogs>;
  quote: typeof quotePublishedGenerationModel;
  loadWelcomeCredits: () => Promise<number | null>;
}

async function loadCatalogModels(platform: 'web' | 'mobile') {
  const snapshot = await loadPublishedGenerationModelCatalog({
    platform,
    schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  });
  return snapshot.catalog.models;
}

const defaultCreationDependencies: HomeShelfCreationDependencies = {
  getPosts: (postIds) => getShowcaseFeedItemsByPostIds({ postIds, viewerUserId: null, countryCode: null }),
  async loadGenerations(generationIds) {
    if (generationIds.length === 0) return [];
    const { data, error } = await createServiceClient()
      .from('generations')
      .select('id, model, workflow_settings, share_input_media_for_remix')
      .in('id', generationIds);
    if (error) throw error;
    return (data ?? []) as ShelfGenerationRow[];
  },
  async loadRecipeHandovers(postIds) {
    const { data, error } = await createServiceClient()
      .from('post_resource_bundles')
      .select('post_id')
      .in('post_id', postIds)
      .eq('status', 'published')
      .eq('allow_remix', true);
    if (error) throw error;
    return new Set(((data ?? []) as Array<{ post_id: string }>).map((row) => row.post_id));
  },
  async loadCatalogs() {
    const [web, mobile] = await Promise.all([loadCatalogModels('web'), loadCatalogModels('mobile')]);
    return { web, mobile };
  },
  quote: quotePublishedGenerationModel,
  loadWelcomeCredits: loadWelcomeCreditAmount,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The settings every editor opens the remix with, or null when they would not
 * open with the same ones. The web's editors restore the generation's top-level
 * values; the app's reads a value under `settings` first and puts a control's
 * default in place of a boolean or number stored as text ("false", "4"), which
 * the web's would send on as text. Either way the card goes without a price
 * rather than show one an editor would not.
 */
export function remixQuoteSettings(
  descriptor: GenerationModelDescriptor,
  stored: Record<string, unknown>,
): Record<string, unknown> | null {
  // Without shared inputs the remix opens without the creator's media.
  const visible = sanitizeWorkflowSettingsForRemix(stored, false);
  const nested = isRecord(visible.settings) ? visible.settings : {};

  for (const control of descriptor.controls) {
    const value = visible[control.key];
    if (control.key in nested && nested[control.key] !== value) return null;
    if (typeof value === 'string' && (control.type === 'boolean' || control.type === 'integer')) return null;
  }

  return visible;
}

/**
 * The card's model and price, or null when the post should not be on the
 * shelf: a generation with no saved recipe opens an editor on its default model
 * (template outputs are saved that way), and a model missing from either
 * published catalog would open a creator that cannot run it.
 */
async function describeShelfPost(
  post: ShowcaseFeedItem,
  generation: ShelfGenerationRow | undefined,
  /** Its recipe hands the creation's inputs to whoever unlocks it (`loadRecipeHandovers`). */
  recipeHandsInputs: boolean,
  catalogs: ShelfCatalogs,
  quote: HomeShelfCreationDependencies['quote'],
): Promise<{ modelName: string; price: HomeShelfPrice | null } | null> {
  const kind = post.remixTarget;
  const stored = isRecord(generation?.workflow_settings) ? generation.workflow_settings : {};
  const modelId = typeof stored.model === 'string' ? stored.model.trim() : '';
  if (!generation || !modelId || (kind !== 'image' && kind !== 'video' && kind !== 'motion')) return null;

  const descriptor = catalogs.web.find((model) => model.id === modelId && model.kind === kind);
  const inAppCatalog = catalogs.mobile.some((model) => model.id === modelId && model.kind === kind);
  if (!descriptor || !inAppCatalog) return null;

  if (kind === 'motion') return { modelName: descriptor.displayName, price: { kind: 'clip-length' } };
  // A creator who shared their inputs hands them to every remix, and the editor
  // prices them; the shelf does not count them, so it shows no price rather
  // than a lower one (and never "Free to try" on it). So does a recipe whose
  // remix switch is on: it hands them to whoever unlocks it, and a free one is
  // unlocked by the Remix tap (`loadGenerationRecipeRemixInputMediaByPostId`).
  if (generation.share_input_media_for_remix === true || recipeHandsInputs) {
    return { modelName: descriptor.displayName, price: null };
  }
  const settings = remixQuoteSettings(descriptor, stored);
  if (!settings) return { modelName: descriptor.displayName, price: null };

  try {
    const quoted = await quote({
      kind,
      modelId: descriptor.id,
      settings,
    }, { platform: 'web' });
    return { modelName: descriptor.displayName, price: { kind: 'credits', credits: quoted.costCredits } };
  } catch {
    return { modelName: descriptor.displayName, price: null };
  }
}

/**
 * Every qualifying pin as a shelf card with its post, in pin order. Not capped:
 * a viewer's own filter runs after this shared build, and `arrangeHomeShelf`
 * caps what is left, so a pin dropped for one viewer lets the next one in.
 * Uncached: `loadHomeShelfCreations` is the cached entry point.
 */
export async function buildHomeShelfCreations(
  pins: readonly HomeShelfPin[],
  dependencies: Partial<HomeShelfCreationDependencies> = {},
): Promise<HomeShelfCreationWithPost[]> {
  const resolved = { ...defaultCreationDependencies, ...dependencies };
  const uniquePins = pins.filter((pin, index) => (
    pin.postId && pins.findIndex((other) => other.postId === pin.postId) === index
  ));
  if (uniquePins.length === 0) return [];

  // Started with the posts read: neither needs it. The catalogs read is joined
  // only once the posts are in, so it is given a handler now: a posts read that
  // fails would otherwise leave its rejection unhandled.
  const catalogsRead = resolved.loadCatalogs();
  catalogsRead.catch(() => undefined);
  const welcomeRead = resolved.loadWelcomeCredits().catch((error) => {
    logBackendError('home_shelf_welcome_credits_load_failed', { error });
    return null;
  });
  const posts = await resolved.getPosts(uniquePins.map((pin) => pin.postId));
  const postById = new Map(posts.map((post) => [post.id, post]));
  const generationIds = posts.flatMap((post) => (post.generationId ? [post.generationId] : []));
  const recipePostIds = posts.flatMap((post) => (post.asset ? [post.id] : []));
  const [generations, recipeHandovers, catalogs, welcomeCredits] = await Promise.all([
    resolved.loadGenerations(generationIds),
    recipePostIds.length > 0 ? resolved.loadRecipeHandovers(recipePostIds) : new Set<string>(),
    catalogsRead,
    welcomeRead,
  ]);
  const generationById = new Map(generations.map((generation) => [generation.id, generation]));

  const creations = await Promise.all(uniquePins.map(async (pin) => {
    const post = postById.get(pin.postId);
    if (!post) return null;
    const facts = await describeShelfPost(
      post,
      post.generationId ? generationById.get(post.generationId) : undefined,
      recipeHandovers.has(post.id),
      catalogs,
      resolved.quote,
    );
    if (!facts) return null;
    const creation = toHomeShelfCreation(post, pin, { ...facts, welcomeCredits });
    return creation ? { ...creation, post } : null;
  }));

  return creations.filter((creation): creation is HomeShelfCreationWithPost => creation !== null);
}

/**
 * Shared by every viewer and both clients: the cards depend only on the pins,
 * so one build serves all of them between rebuilds. The pins are part of the
 * key, so a deploy that changes them never reads an old build, and so is the
 * build version, for a deploy that changes the rules. It carries the feed's
 * tag: a moderation take-down, an archive or a delete invalidates it
 * (`invalidateShowcaseFeedCache`), and drops the post from the shelf at once.
 * A build that throws is not kept.
 */
const loadCachedHomeShelfCreations = unstable_cache(
  async (pinsKey: string) => buildHomeShelfCreations(JSON.parse(pinsKey) as HomeShelfPin[]),
  [HOME_SHELF_BUILD_VERSION],
  { revalidate: HOME_SHELF_REVALIDATE_SECONDS, tags: [SHOWCASE_FEED_CACHE_TAG] },
);

/**
 * Whether enough posts are pinned for a shelf at all: the one place this is
 * decided, read by the signed-in page before it holds the row's place.
 */
export function homeShelfHasEnoughPins(): boolean {
  return HOME_SHELF_PINS.length >= HOME_SHELF_MIN_CREATIONS;
}

async function loadHomeShelfCreations(failure: FailureMode): Promise<HomeShelfCreationWithPost[]> {
  if (!homeShelfHasEnoughPins()) return [];
  try {
    return await loadCachedHomeShelfCreations(JSON.stringify(HOME_SHELF_PINS));
  } catch (error) {
    logBackendError('home_shelf_creations_load_failed', { error });
    if (failure === 'throw') throw new HomeShelfUnavailableError('The shelf could not be read.');
    return [];
  }
}

/**
 * What the feed leaves out for this viewer leaves the shelf too: creators with
 * a block either way, creators they hid, posts they marked Not interested, and
 * posts they reported. Their own posts stay: remaking your own creation is fine.
 */
function isExcludedForViewer(post: ShowcaseFeedItem, relations: FeedViewerRelations): boolean {
  const creatorId = post.creator?.id ?? null;
  if (creatorId && (relations.blockedCreatorIds.has(creatorId) || relations.hiddenCreatorIds.has(creatorId))) {
    return true;
  }
  return relations.hiddenPostIds.has(post.id) || relations.reportedPostIds.has(post.id);
}

/** Whether the member has a post on the feed: public, live, not hidden. */
async function hasPublicPost(viewerUserId: string): Promise<boolean> {
  const { data, error } = await createServiceClient()
    .from('posts')
    .select('id')
    .eq('user_id', viewerUserId)
    .eq('visibility', 'public')
    .eq('review_status', 'visible')
    .is('archived_at', null)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

async function loadMemberActions(viewerUserId: string): Promise<HomeShelfAction[]> {
  const [hasPosted, terms] = await Promise.all([hasPublicPost(viewerUserId), loadReferralProgramTerms()]);
  return selectHomeShelfActions({ hasPosted }, {
    referral: terms
      ? { inviterPercent: terms.inviterPercent, inviteePercent: terms.inviteeFirstPurchasePercent }
      : null,
    earnEnabled: HOME_SHELF_EARN_CARD_ENABLED,
    creatorSharePercent: POST_RESOURCE_CREATOR_SHARE_PERCENT,
  });
}

/**
 * The shelf for one viewer, each creation with its post. The shared build is
 * filtered through the feed's own read of the viewer's relations
 * (`loadViewerRelations`), and like the feed, a read that fails shows nothing
 * rather than an unverified creator. A member's offers are read only when
 * there is a shelf to put them in.
 */
async function loadHomeShelfForViewer(
  identity: HomeShelfIdentity,
  failure: FailureMode,
  { withOffers = true }: { withOffers?: boolean } = {},
): Promise<Array<HomeShelfCreationWithPost | HomeShelfAction>> {
  const creations = await loadHomeShelfCreations(failure);
  if (creations.length < HOME_SHELF_MIN_CREATIONS || !identity.viewerUserId) {
    return arrangeHomeShelf(creations, []);
  }

  const viewerUserId = identity.viewerUserId;
  const [relations, actions] = await Promise.all([
    // Logs and answers null on a failed read.
    loadViewerRelations({
      followingCreatorIds: new Set(),
      items: creations.map((creation) => creation.post),
      serviceClient: createServiceClient(),
      viewerUserId,
    }),
    identity.isAnonymous || !withOffers
      ? Promise.resolve([])
      : loadMemberActions(viewerUserId).catch((error) => {
          // The offers wait for the next visit; the creations still render.
          logBackendError('home_shelf_actions_load_failed', { error });
          return [] as HomeShelfAction[];
        }),
  ]);
  if (!relations) {
    if (failure === 'throw') throw new HomeShelfUnavailableError('The shelf could not be filtered for its viewer.');
    return [];
  }

  const visible = creations.filter((creation) => !isExcludedForViewer(creation.post, relations));
  return arrangeHomeShelf(visible, actions);
}

export function withoutPost({ post, ...creation }: HomeShelfCreationWithPost): HomeShelfCreation {
  void post;
  return creation;
}

/** The shelf as the web pages render it; no full posts reach the client. The signed-out page passes no viewer. */
export async function loadHomeShelf(identity: HomeShelfIdentity = SIGNED_OUT): Promise<HomeShelfItem[]> {
  const items = await loadHomeShelfForViewer(identity, 'empty');
  return items.map((item) => (item.kind === 'creation' ? withoutPost(item) : item));
}

/**
 * The shelf's shared build, for every viewer alike (none where there are too few
 * pins or it cannot be read): what the creators' remix forecasts are keyed by,
 * so a viewer's hides and blocks never make a build of their own.
 */
export async function loadSharedHomeShelfCreations(): Promise<HomeShelfCreationWithPost[]> {
  return loadHomeShelfCreations('empty');
}

/**
 * The shelf's creations for one viewer, each with its post and without the
 * offers: the creators' "Start from a post" (`creator-start-posts-server.ts`).
 * Empty where the web pages' shelf would draw nothing.
 */
export async function loadHomeShelfCreationsWithPosts(identity: HomeShelfIdentity): Promise<HomeShelfCreationWithPost[]> {
  const items = await loadHomeShelfForViewer(identity, 'empty', { withOffers: false });
  return items.filter((item): item is HomeShelfCreationWithPost => item.kind === 'creation');
}

/**
 * The shelf as `/api/home/shelf` sends it to the app: each creation with its
 * post. Throws `HomeShelfUnavailableError` where the web pages' loader would
 * draw nothing.
 */
export async function loadHomeShelfForApi(identity: HomeShelfIdentity): Promise<HomeShelfApiItem[]> {
  return loadHomeShelfForViewer(identity, 'throw');
}
