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
  arrangeHomeShelf,
  selectHomeShelfActions,
  toHomeShelfCreation,
  type HomeShelfAction,
  type HomeShelfCreation,
  type HomeShelfItem,
  type HomeShelfPin,
  type HomeShelfPrice,
  type HomeShelfViewer,
} from '@/lib/home-shelf';
import { HOME_SHELF_EARN_CARD_ENABLED, HOME_SHELF_PINS } from '@/lib/home-shelf-lineup';
import { WELCOME_CREDIT_PROGRAM_KEY } from '@/lib/onboarding';
import { POST_RESOURCE_CREATOR_SHARE_PERCENT } from '@/lib/post-resource-commerce';
import { loadReferralProgramTerms } from '@/lib/referral-route-service';
import { createServiceClient } from '@/lib/server-helpers';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import { getShowcaseFeedItemsByPostIds } from '@/lib/showcase-feed';

/**
 * Server side of the "Make this" shelf (`home-shelf.ts`): reads the pinned
 * posts, prices each one the way its creator page will, and works out which
 * action cards a viewer is offered. Every loader degrades to an empty shelf
 * instead of throwing, as the other home loaders do: Home renders without it.
 */

/**
 * How long a built shelf is reused. The pins change by deploy, so this only
 * bounds how stale a price, a moderation hide or an archive can be.
 */
const HOME_SHELF_REVALIDATE_SECONDS = 300;

export const HOME_SHELF_CACHE_TAG = 'home-shelf';

/** A creation card and the post behind it: the app's remix flow takes the post itself. */
export interface HomeShelfCreationEntry {
  creation: HomeShelfCreation;
  post: ShowcaseFeedItem;
}

/** What `/api/home/shelf` sends per item: creations carry their post for the app. */
export type HomeShelfApiItem = (HomeShelfCreation & { post: ShowcaseFeedItem }) | HomeShelfAction;

interface ShelfGenerationRow {
  id: string;
  model: string | null;
  workflow_settings: Record<string, unknown> | null;
  share_input_media_for_remix: boolean | null;
}

export interface HomeShelfCreationDependencies {
  getPosts: (postIds: string[]) => Promise<ShowcaseFeedItem[]>;
  loadGenerations: (generationIds: string[]) => Promise<ShelfGenerationRow[]>;
  loadCatalogModels: () => Promise<GenerationModelDescriptor[]>;
  quote: typeof quotePublishedGenerationModel;
  loadWelcomeCredits: () => Promise<number | null>;
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
  async loadCatalogModels() {
    const snapshot = await loadPublishedGenerationModelCatalog({
      platform: 'web',
      schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
    });
    return snapshot.catalog.models;
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
  generation: ShelfGenerationRow,
): Record<string, unknown> {
  const stored = isRecord(generation.workflow_settings) ? generation.workflow_settings : {};
  // A viewer who is not the creator gets the settings without the creator's
  // input media, unless the creator shared it for remixing.
  const visible = sanitizeWorkflowSettingsForRemix(stored, generation.share_input_media_for_remix === true);
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

async function priceShelfPost(
  post: ShowcaseFeedItem,
  generation: ShelfGenerationRow | undefined,
  models: GenerationModelDescriptor[],
  quote: HomeShelfCreationDependencies['quote'],
): Promise<{ modelName: string | null; price: HomeShelfPrice | null }> {
  const kind = post.remixTarget;
  const stored = isRecord(generation?.workflow_settings) ? generation.workflow_settings : {};
  const modelId = typeof stored.model === 'string' && stored.model.trim()
    ? stored.model.trim()
    : generation?.model ?? null;
  const descriptor = models.find((model) => model.id === modelId && model.kind === kind);
  const modelName = descriptor?.displayName ?? (post.model?.trim() || null);

  if (kind === 'motion') return { modelName, price: { kind: 'clip-length' } };
  if (!descriptor || !generation || (kind !== 'image' && kind !== 'video')) return { modelName, price: null };

  try {
    // No input counts: the shelf prices what a viewer opens, and the creator's
    // inputs travel only when shared. A model that needs an input of the
    // viewer's own fails here and shows no price rather than a wrong one.
    const quoted = await quote({
      kind,
      modelId: descriptor.id,
      settings: remixQuoteSettings(descriptor, generation),
    }, { platform: 'web' });
    return { modelName, price: { kind: 'credits', credits: quoted.costCredits } };
  } catch {
    return { modelName, price: null };
  }
}

/**
 * The qualifying pins as shelf cards, in pin order, at most
 * HOME_SHELF_MAX_CREATIONS of them. Uncached: `loadHomeShelfCreationEntries`
 * is the cached entry point.
 */
export async function buildHomeShelfCreationEntries(
  pins: readonly HomeShelfPin[],
  dependencies: Partial<HomeShelfCreationDependencies> = {},
): Promise<HomeShelfCreationEntry[]> {
  const resolved = { ...defaultCreationDependencies, ...dependencies };
  const uniquePins = pins.filter((pin, index) => (
    pin.postId && pins.findIndex((other) => other.postId === pin.postId) === index
  ));
  if (uniquePins.length === 0) return [];

  const posts = await resolved.getPosts(uniquePins.map((pin) => pin.postId));
  const postById = new Map(posts.map((post) => [post.id, post]));
  const generationIds = posts.flatMap((post) => (post.generationId ? [post.generationId] : []));
  const [generations, models, welcomeCredits] = await Promise.all([
    resolved.loadGenerations(generationIds),
    resolved.loadCatalogModels(),
    resolved.loadWelcomeCredits().catch((error) => {
      logBackendError('home_shelf_welcome_credits_load_failed', { error });
      return null;
    }),
  ]);
  const generationById = new Map(generations.map((generation) => [generation.id, generation]));

  const entries = await Promise.all(uniquePins.map(async (pin) => {
    const post = postById.get(pin.postId);
    if (!post) return null;
    const facts = await priceShelfPost(
      post,
      post.generationId ? generationById.get(post.generationId) : undefined,
      models,
      resolved.quote,
    );
    const creation = toHomeShelfCreation(post, pin, { ...facts, welcomeCredits });
    return creation ? { creation, post } : null;
  }));

  return entries
    .filter((entry): entry is HomeShelfCreationEntry => entry !== null)
    .slice(0, HOME_SHELF_MAX_CREATIONS);
}

/**
 * Shared by every viewer and both clients: the cards depend only on the pins,
 * so one build serves all of them for HOME_SHELF_REVALIDATE_SECONDS. The pins
 * are part of the key, so a deploy that changes them never reads an old build.
 */
const loadCachedHomeShelfCreationEntries = unstable_cache(
  async (pinsKey: string) => buildHomeShelfCreationEntries(JSON.parse(pinsKey) as HomeShelfPin[]),
  ['home-shelf-creations'],
  { revalidate: HOME_SHELF_REVALIDATE_SECONDS, tags: [HOME_SHELF_CACHE_TAG] },
);

export async function loadHomeShelfCreationEntries(): Promise<HomeShelfCreationEntry[]> {
  if (HOME_SHELF_PINS.length === 0) return [];
  try {
    return await loadCachedHomeShelfCreationEntries(JSON.stringify(HOME_SHELF_PINS));
  } catch (error) {
    logBackendError('home_shelf_creations_load_failed', { error });
    return [];
  }
}

/**
 * Who the viewer is to the shelf. A guest, or no identity at all, is signed
 * out; a member is asked to post until they have, which is read here.
 */
export async function loadHomeShelfViewer({
  viewerUserId,
  isAnonymous,
}: {
  viewerUserId: string | null;
  isAnonymous: boolean;
}): Promise<HomeShelfViewer> {
  if (!viewerUserId || isAnonymous) return { kind: 'signed-out' };

  const { count, error } = await createServiceClient()
    .from('posts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', viewerUserId)
    .is('archived_at', null);
  if (error) throw error;

  return { kind: 'member', hasPosted: (count ?? 0) > 0 };
}

export async function loadHomeShelfActions(viewer: HomeShelfViewer): Promise<HomeShelfAction[]> {
  if (viewer.kind !== 'member') return [];

  const terms = await loadReferralProgramTerms();
  return selectHomeShelfActions(viewer, {
    referral: terms
      ? { inviterPercent: terms.inviterPercent, inviteePercent: terms.inviteeFirstPurchasePercent }
      : null,
    earnEnabled: HOME_SHELF_EARN_CARD_ENABLED,
    creatorSharePercent: POST_RESOURCE_CREATOR_SHARE_PERCENT,
  });
}

/**
 * The action cards for a viewer, or none when the viewer cannot be read: the
 * shelf's creations still render, and the offers wait for the next visit.
 */
async function loadHomeShelfActionsSafely(identity: {
  viewerUserId: string | null;
  isAnonymous: boolean;
}): Promise<HomeShelfAction[]> {
  if (!identity.viewerUserId || identity.isAnonymous) return [];
  try {
    return await loadHomeShelfActions(await loadHomeShelfViewer(identity));
  } catch (error) {
    logBackendError('home_shelf_actions_load_failed', { error });
    return [];
  }
}

/** The shelf as the web pages render it. The signed-out page passes no viewer. */
export async function loadHomeShelf(identity: {
  viewerUserId: string | null;
  isAnonymous: boolean;
} = { viewerUserId: null, isAnonymous: false }): Promise<HomeShelfItem[]> {
  const [entries, actions] = await Promise.all([
    loadHomeShelfCreationEntries(),
    loadHomeShelfActionsSafely(identity),
  ]);

  return arrangeHomeShelf(entries.map((entry) => entry.creation), actions);
}

/** The shelf as `/api/home/shelf` sends it to the app: each creation with its post. */
export async function loadHomeShelfForApi(identity: {
  viewerUserId: string | null;
  isAnonymous: boolean;
}): Promise<HomeShelfApiItem[]> {
  const [entries, actions] = await Promise.all([
    loadHomeShelfCreationEntries(),
    loadHomeShelfActionsSafely(identity),
  ]);
  const postById = new Map(entries.map((entry) => [entry.creation.id, entry.post]));

  return arrangeHomeShelf(entries.map((entry) => entry.creation), actions).flatMap((item): HomeShelfApiItem[] => {
    if (item.kind !== 'creation') return [item];
    const post = postById.get(item.id);
    return post ? [{ ...item, post }] : [];
  });
}
