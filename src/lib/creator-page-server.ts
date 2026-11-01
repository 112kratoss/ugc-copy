import 'server-only';

import { unstable_cache } from 'next/cache';

import { catalogRunQuoteInput } from '../../ugc-mobile/lib/model-catalog/protocol';
import type { CreatorWelcome } from '@/components/CreatorWelcomeCard';
import { requestHasAuthHint } from '@/components/RouteAuthBoundary';
import { CREATOR_HANDOVER_PARAM, CREATOR_WELCOME_PARAM } from '@/lib/auth-onboarding';
import { logBackendError } from '@/lib/backend-logger';
import { creatorOpeningFromCatalog, type CreatorOpening, type CreatorOpeningLink } from '@/lib/creator-opening';
import type { CreatorStartPost } from '@/lib/creator-start-posts';
import { loadCreatorStartPosts } from '@/lib/creator-start-posts-server';
import {
  CatalogError,
  GENERATION_MODEL_CATALOG_DESCRIPTOR_SCHEMA_VERSION,
  quoteGenerationModel,
  type GenerationModelKind,
} from '@/lib/generation-model-catalog';
import { loadPublishedGenerationModelCatalog } from '@/lib/generation-model-catalog-store';
import { REFERRAL_CLAIM_REASON_PATTERN, REFERRAL_CLAIM_STATUS_PARAM } from '@/lib/referral-claim-copy';
import { getServerAuthState } from '@/lib/supabase-server';
import { loadWelcomeCreditAmount } from '@/lib/welcome-credit-program-server';

type CreatorSearchParams = Record<string, string | string[] | undefined>;

/** What a creator page's address says about a way back from the creators' sign-up sheet. */
export type CreatorReturn = {
  /** `?welcome=1` from the post-auth redirect, with the invite's outcome when it carried one. */
  welcome: CreatorWelcome | null;
  /** The sheet's `?handover=` nonce, which the visitor's saved draft is moved by. */
  handoverNonce: string | null;
};

const HANDOVER_NONCE_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function readCreatorReturn(params: CreatorSearchParams): CreatorReturn {
  const referral = firstValue(params[REFERRAL_CLAIM_STATUS_PARAM]) ?? null;
  const handover = firstValue(params[CREATOR_HANDOVER_PARAM]) ?? null;
  return {
    welcome: firstValue(params[CREATOR_WELCOME_PARAM]) === '1'
      ? { referral: referral && REFERRAL_CLAIM_REASON_PATTERN.test(referral) ? referral : null }
      : null,
    handoverNonce: handover && HANDOVER_NONCE_PATTERN.test(handover) ? handover : null,
  };
}

// The grant changes only with the program, so the creators' traffic is answered
// from the data cache rather than with a query for each page.
const loadCachedWelcomeCreditAmount = unstable_cache(loadWelcomeCreditAmount, ['creator-visitor-welcome-credits'], {
  revalidate: 300,
});

/**
 * What a new account starts with: the creator tells a visitor what signing up
 * gives them. Read for a signed-in page too, whose form a sign-out made in this
 * browser gives to the visitor. Null while the welcome program is off or cannot
 * be read.
 */
export async function loadVisitorWelcomeCredits(): Promise<number | null> {
  try {
    return await loadCachedWelcomeCreditAmount();
  } catch (error) {
    logBackendError('creator_visitor_welcome_credits_load_failed', { error });
    return null;
  }
}

/**
 * The posts a creator's empty canvas offers to start from (`loadCreatorStartPosts`), for
 * this request's viewer: one with no sign-in cookie is a visitor. Handed to the page
 * unawaited, so the creator draws at once and the posts stream in after. Never throws:
 * the canvas draws without them.
 */
export async function loadCreatorStartPostsForRequest(): Promise<CreatorStartPost[]> {
  try {
    if (!(await requestHasAuthHint())) {
      return await loadCreatorStartPosts({ viewerUserId: null, isAnonymous: false });
    }
    const user = (await getServerAuthState()).session?.user ?? null;
    return await loadCreatorStartPosts({ viewerUserId: user?.id ?? null, isAnonymous: user?.is_anonymous === true });
  } catch (error) {
    logBackendError('creator_start_posts_load_failed', { error });
    return [];
  }
}

async function readCreatorOpening(kind: GenerationModelKind, link: CreatorOpeningLink): Promise<CreatorOpening | null> {
  // The store's own copy of the release, at most a minute old on this instance, as the quote route reads it.
  // A data cache over it outlived publishes and rollbacks, and deployments, which no key here could name.
  const snapshot = await loadPublishedGenerationModelCatalog({
    platform: 'web',
    schemaVersion: GENERATION_MODEL_CATALOG_DESCRIPTOR_SCHEMA_VERSION,
  });
  const opening = creatorOpeningFromCatalog(snapshot.catalog, kind, link);
  if (!opening) return null;
  // A motion run takes a clip and is priced by its length: it opens unpriced.
  if (kind === 'motion') return { ...opening, costCredits: null };
  try {
    // Priced on the release just read, as a start prices its run (`unified-generation-start-service`).
    const quote = quoteGenerationModel(catalogRunQuoteInput({
      kind,
      modelId: opening.modelId,
      catalogRevision: opening.revision,
      settings: opening.settings,
      inputs: [],
    }), { catalog: snapshot.catalog, operations: snapshot.operations });
    return { ...opening, costCredits: quote.costCredits };
  } catch (error) {
    // A run the catalog will not price without inputs opens unpriced; anything else is a fault.
    if (!(error instanceof CatalogError)) {
      logBackendError('creator_opening_price_failed', { error, kind, modelId: opening.modelId });
    }
    return { ...opening, costCredits: null };
  }
}

/**
 * The run a creator page opens on (`CreatorOpening`), from the published web catalog: a link's
 * model, or the default, at its published settings and price. Null when the catalog cannot be
 * read, or a link names a model the page cannot draw or the catalog does not offer; the page then
 * draws its own stand-in until its first pick. Never throws.
 */
export async function loadCreatorOpening(kind: GenerationModelKind, link: CreatorOpeningLink = {}): Promise<CreatorOpening | null> {
  try {
    return await readCreatorOpening(kind, link);
  } catch (error) {
    logBackendError('creator_opening_load_failed', { error, kind });
    return null;
  }
}
