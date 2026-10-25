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
import {
  HOME_SHELF_MAX_CREATIONS,
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
import { loadBlockedCreatorIds } from '@/lib/moderation-service';
import { WELCOME_CREDIT_PROGRAM_KEY } from '@/lib/onboarding';
import { POST_RESOURCE_CREATOR_SHARE_PERCENT } from '@/lib/post-resource-commerce';
import { loadReferralProgramTerms } from '@/lib/referral-route-service';
import { createServiceClient } from '@/lib/server-helpers';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import { getShowcaseFeedItemsByPostIds } from '@/lib/showcase-feed';
import { SHOWCASE_FEED_CACHE_TAG } from '@/lib/showcase-feed-cache';

/**
 * Server side of the "Make this" shelf (`home-shelf.ts`): reads the pinned
 * posts, prices each one the way its creator page will, and works out which
 * action cards a viewer is offered. Every loader degrades to an empty shelf
 * instead of throwing, as the other home loaders do: Home renders without it.
 */

/** How long a built shelf is reused between rebuilds. */
const HOME_SHELF_REVALIDATE_SECONDS = 300;

const HOME_SHELF_CACHE_TAG = 'home-shelf';

/**
 * Who asked. No id is a signed-out visitor; a guest's id is read for blocks
 * but offered what a signed-out visitor is.
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

interface ShelfGenerationRow {
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
  async loadCatalogs() {
    const [web, mobile] = await Promise.all([loadCatalogModels('web'), loadCatalogModels('mobile')]);
    return { web, mobile };
  },
  quote: quotePublishedGenerationModel,
  async loadWelcomeCredits() {
    const { data, error } = await createServiceClient()
      .from('credit_grant_programs')
      .select('amount, enabled')
      .eq('program_key', WELCOME_CREDIT_PROGRAM_KEY)
      .maybeSingle();
    if (error) throw error;
    const program = data as { amount?: unknown; enabled?: unknown } | null;
    const amount = Number(program?.amount);
    return program?.enabled === true && Number.isFinite(amount) && amount > 0 ? amount : null;
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The settings the remix opens with, in the types the quote expects. The
 * editor restores them from the generation's own copy, where a boolean or a
 * number can be stored as text ("false", "4").
 */
function remixQuoteSettings(
  descriptor: GenerationModelDescriptor,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  // Without shared inputs the remix opens without the creator's media.
  const visible = sanitizeWorkflowSettingsForRemix(stored, false);
  const merged: Record<string, unknown> = {
    ...(isRecord(visible.settings) ? visible.settings : {}),
    ...visible,
  };

  for (const control of descriptor.controls) {
    const value = merged[control.key];
    if (typeof value !== 'string') continue;
    if (control.type === 'boolean' && (value === 'true' || value === 'false')) {
      merged[control.key] = value === 'true';
    } else if (control.type === 'integer' && value.trim() !== '' && Number.isFinite(Number(value))) {
      merged[control.key] = Number(value);
    }
  }

  return merged;
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
  // than a lower one (and never "Free to try" on it).
  if (generation.share_input_media_for_remix === true) return { modelName: descriptor.displayName, price: null };

  try {
    const quoted = await quote({
      kind,
      modelId: descriptor.id,
      settings: remixQuoteSettings(descriptor, stored),
    }, { platform: 'web' });
    return { modelName: descriptor.displayName, price: { kind: 'credits', credits: quoted.costCredits } };
  } catch {
    return { modelName: descriptor.displayName, price: null };
  }
}

/**
 * The qualifying pins as shelf cards with their posts, in pin order, at most
 * HOME_SHELF_MAX_CREATIONS of them. Uncached: `loadHomeShelfCreations` is the
 * cached entry point.
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

  // Started with the posts read: neither needs it.
  const catalogsRead = resolved.loadCatalogs();
  const welcomeRead = resolved.loadWelcomeCredits().catch((error) => {
    logBackendError('home_shelf_welcome_credits_load_failed', { error });
    return null;
  });
  const posts = await resolved.getPosts(uniquePins.map((pin) => pin.postId));
  const postById = new Map(posts.map((post) => [post.id, post]));
  const generationIds = posts.flatMap((post) => (post.generationId ? [post.generationId] : []));
  const [generations, catalogs, welcomeCredits] = await Promise.all([
    resolved.loadGenerations(generationIds),
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
      catalogs,
      resolved.quote,
    );
    if (!facts) return null;
    const creation = toHomeShelfCreation(post, pin, { ...facts, welcomeCredits });
    return creation ? { ...creation, post } : null;
  }));

  return creations
    .filter((creation): creation is HomeShelfCreationWithPost => creation !== null)
    .slice(0, HOME_SHELF_MAX_CREATIONS);
}

/**
 * Shared by every viewer and both clients: the cards depend only on the pins,
 * so one build serves all of them between rebuilds. The pins are part of the
 * key, so a deploy that changes them never reads an old build. The feed's tag
 * is carried too: a moderation take-down, an archive or a delete invalidates
 * it (`invalidateShowcaseFeedCache`), and drops the post from the shelf at once.
 */
const loadCachedHomeShelfCreations = unstable_cache(
  async (pinsKey: string) => buildHomeShelfCreations(JSON.parse(pinsKey) as HomeShelfPin[]),
  ['home-shelf-creations'],
  { revalidate: HOME_SHELF_REVALIDATE_SECONDS, tags: [HOME_SHELF_CACHE_TAG, SHOWCASE_FEED_CACHE_TAG] },
);

async function loadHomeShelfCreations(): Promise<HomeShelfCreationWithPost[]> {
  if (HOME_SHELF_PINS.length < HOME_SHELF_MIN_CREATIONS) return [];
  try {
    return await loadCachedHomeShelfCreations(JSON.stringify(HOME_SHELF_PINS));
  } catch (error) {
    logBackendError('home_shelf_creations_load_failed', { error });
    return [];
  }
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
  return selectHomeShelfActions({ kind: 'member', hasPosted }, {
    referral: terms
      ? { inviterPercent: terms.inviterPercent, inviteePercent: terms.inviteeFirstPurchasePercent }
      : null,
    earnEnabled: HOME_SHELF_EARN_CARD_ENABLED,
    creatorSharePercent: POST_RESOURCE_CREATOR_SHARE_PERCENT,
  });
}

/**
 * The shelf for one viewer, each creation with its post. The shared build is
 * filtered by the viewer's blocks both ways, as the feed is (and, like the
 * feed, a block check that fails shows nothing rather than an unverified
 * creator); a member's offers are read only when there is a shelf to put them in.
 */
async function loadHomeShelfForViewer(identity: HomeShelfIdentity): Promise<Array<HomeShelfCreationWithPost | HomeShelfAction>> {
  const creations = await loadHomeShelfCreations();
  if (creations.length < HOME_SHELF_MIN_CREATIONS || !identity.viewerUserId) {
    return arrangeHomeShelf(creations, []);
  }

  const viewerUserId = identity.viewerUserId;
  const [blocked, actions] = await Promise.all([
    loadBlockedCreatorIds({
      adminSupabase: createServiceClient(),
      creatorIds: creations.flatMap((creation) => (creation.post.creator?.id ? [creation.post.creator.id] : [])),
      viewerUserId,
    }).catch((error) => {
      logBackendError('home_shelf_block_filter_failed', { error });
      return null;
    }),
    identity.isAnonymous
      ? Promise.resolve([])
      : loadMemberActions(viewerUserId).catch((error) => {
          // The offers wait for the next visit; the creations still render.
          logBackendError('home_shelf_actions_load_failed', { error });
          return [] as HomeShelfAction[];
        }),
  ]);
  if (!blocked) return [];

  const visible = creations.filter((creation) => !creation.post.creator?.id || !blocked.has(creation.post.creator.id));
  return arrangeHomeShelf(visible, actions);
}

function withoutPost({ post, ...creation }: HomeShelfCreationWithPost): HomeShelfCreation {
  void post;
  return creation;
}

/** The shelf as the web pages render it; no full posts reach the client. The signed-out page passes no viewer. */
export async function loadHomeShelf(identity: HomeShelfIdentity = SIGNED_OUT): Promise<HomeShelfItem[]> {
  const items = await loadHomeShelfForViewer(identity);
  return items.map((item) => (item.kind === 'creation' ? withoutPost(item) : item));
}

/** The shelf as `/api/home/shelf` sends it to the app: each creation with its post. */
export async function loadHomeShelfForApi(identity: HomeShelfIdentity): Promise<HomeShelfApiItem[]> {
  return loadHomeShelfForViewer(identity);
}
