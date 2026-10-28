'use client';

import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@/components/AuthProvider';
import { sharePublicGeneration } from '@/lib/share-client';
import type { GenerationShareSourceSurface } from '@/lib/share';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import {
  followCreationTitleSuggestion,
  getCreationPostTitleSuggestion,
  getCreationTitleSuggestionHint,
  recipeKeepsPromptPrivate,
  type CreationTitleSource,
} from '@/lib/creation-post-title';
import { getCreatorProfileReadiness, type ProfileApiResponse } from '@/lib/profile';
import {
  getInitialPublicIdentity,
  claimPublicIdentity,
  validatePublicIdentity,
  type PublicIdentityDraft,
  type PublicIdentityErrors,
} from '@/lib/public-identity';
import {
  getPostResourceKindLabel,
  POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS,
  POST_RESOURCE_PRICE_INCREMENT_USD_CENTS,
  type PersistedPostResourceBundleAccessMode,
  type PostResourceBundleAccessMode,
  type PostResourceBundleInput,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';

/**
 * One way to publish a creation, behind two faces: the Publish window (Studio, template runs)
 * and the creators' own form on the canvas (the artboard Result). The draft (title and its
 * suggestion, the name and handle a first post saves, the recipe, NSFW), the request to
 * `/api/showcase/publish`, its errors and what it answers all live here, so the two cannot
 * drift apart; each face only draws them.
 */

/** A post is public or private (decision 12, 2026-10-17); the server answers no other. */
export type PostVisibility = 'public' | 'private';
type ProfileLoadState = 'idle' | 'loading' | 'ready' | 'error';

/** What a publish answers, as the page that asked keeps it. */
export type PublishedCreation = {
  title: string;
  description: string;
  visibility?: PostVisibility;
  resourceBundleStatus?: 'draft' | 'published' | null;
  resourceBundlePath?: string | null;
  postId?: string | null;
  showcasePath?: string | null;
  ownerPath?: string | null;
};

const RESOURCE_KIND_ORDER: PostResourceKind[] = ['prompt', 'workflow', 'files', 'notes', 'remix'];

const DEFAULT_RECIPE_PRICE_TOKENS = 900;

function normalizeOptionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The caption is the post's public description. It must not start out as the
 * recipe's generated setup notes: those travel with the bundle (see
 * `buildAutoResourceBundle`), and prefilling them here published "Saved
 * generation setup / Model: …" as the caption of every quick publish.
 */
function getDefaultPublishDescription(defaultDescription: string): string {
  return defaultDescription.trim();
}

/**
 * Prices are credit counts. `price_usd_cents` stores the count directly -- at
 * the fixed 100 credits to $1 the two numbers are the same.
 */
function parsePriceTokens(value: string): number | null {
  const normalized = Number.parseInt(value.trim(), 10);
  return Number.isFinite(normalized) ? normalized : null;
}

function getAutoUnlockKinds(prefill: GenerationPaywallPrefill | null | undefined): PostResourceKind[] {
  if (!prefill) {
    return [];
  }

  const kinds = new Set<PostResourceKind>(prefill.resourceKinds);
  if ((prefill.referenceCount ?? 0) > 0) {
    kinds.add('files');
  }
  if (prefill.promptText?.trim()) {
    kinds.add('prompt');
  }
  if (prefill.notesMarkdown?.trim()) {
    kinds.add('notes');
  }
  if (prefill.allowRemix) {
    kinds.add('remix');
  }

  return RESOURCE_KIND_ORDER.filter((kind) => kinds.has(kind));
}

/**
 * The prefill as a recipe holds it without the creator's own uploads: their references gone
 * from its files, and with any of them in the creation, the remix's hand-over too, which would
 * give them all away (owner, 2026-10-29).
 */
function withoutOwnUploads(prefill: GenerationPaywallPrefill, ownCount: number): GenerationPaywallPrefill {
  const referenceCount = Math.max(0, Math.round(prefill.referenceCount ?? 0) - ownCount);
  const allowRemix = prefill.allowRemix && ownCount === 0;
  return {
    ...prefill,
    referenceCount,
    allowRemix,
    resourceKinds: prefill.resourceKinds.filter((kind) => (kind !== 'files' || referenceCount > 0) && (kind !== 'remix' || allowRemix)),
  };
}

/** "prompt, files and notes": the kinds in words, the last joined with "and". */
function listAutoUnlockKinds(kinds: PostResourceKind[]): string {
  const labels = kinds.map((kind) => getPostResourceKindLabel(kind).toLowerCase());
  return labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

// Buyers read this first, as a listing's line: it starts with a capital
// (A-F8) where several kinds read "prompt, files and notes from…".
function buildAutoUnlockSummary(kinds: PostResourceKind[]): string {
  if (kinds.length === 0) {
    return 'Saved creation setup';
  }

  const listed = listAutoUnlockKinds(kinds);
  return `${listed.charAt(0).toUpperCase()}${listed.slice(1)} from this creation`;
}

function buildAutoUnlockPreview(kinds: PostResourceKind[]): string {
  if (kinds.length === 0) {
    return 'Unlock the saved system details behind this generated media.';
  }

  return `Unlock the saved ${listAutoUnlockKinds(kinds)} used to create this result.`;
}

function buildAutoResourceBundle({
  prefill,
  accessMode,
  priceUsdCents,
}: {
  prefill: GenerationPaywallPrefill;
  accessMode: PersistedPostResourceBundleAccessMode;
  priceUsdCents: number;
}): PostResourceBundleInput {
  const kinds = getAutoUnlockKinds(prefill);

  return {
    accessMode,
    summary: buildAutoUnlockSummary(kinds),
    previewText: buildAutoUnlockPreview(kinds),
    priceUsdCents,
    resources: {
      promptText: prefill.promptText?.trim() || null,
      notesMarkdown: prefill.notesMarkdown?.trim() || null,
      workflowShareUrl: null,
      attachments: [],
      allowRemix: prefill.allowRemix,
    },
  };
}

export interface UsePublishCreationOptions {
  /** The window is open, or the form is on the canvas: a fresh draft starts each time it becomes so. */
  active: boolean;
  generationId: string | null;
  accessToken?: string | null;
  defaultTitle?: string;
  /**
   * The creation's prompt, model and category, from which a title is
   * suggested when it has none of its own (`defaultTitle`).
   */
  creation?: CreationTitleSource | null;
  defaultDescription?: string;
  showPaidShortcut?: boolean;
  mediaOnly?: boolean;
  paywallPrefill?: GenerationPaywallPrefill | null;
  /** The title of the post a remix was made from: an untitled remix starts from it ("intense (remix)"). */
  remixOfTitle?: string | null;
  /**
   * The recipe a fresh draft starts with where the creation has one to offer: the window
   * starts with none, for the creator to opt in; the creators' form with a free one (owner,
   * 2026-10-28). Until the creator picks one themselves, a prefill arriving late sets it too.
   */
  startingRecipe?: 'none' | 'free';
  /**
   * The recipe leaves the creator's own uploads out until they add them (the creators' form,
   * owner 2026-10-29): only the references a remix brought from its original go in, and with
   * any of their own in the creation none is handed to a remix. The window shares them all.
   */
  leavesOwnUploadsOut?: boolean;
  shareAfterPublish?: {
    title: string;
    description?: string | null;
    sourceSurface: GenerationShareSourceSurface;
  };
  onPublished?: (payload: PublishedCreation) => void;
  /** After a publish and the share that follows it: the window closes here. */
  onFinished?: () => void;
}

export function usePublishCreation({
  active,
  generationId,
  accessToken = null,
  defaultTitle = '',
  creation = null,
  defaultDescription = '',
  showPaidShortcut = true,
  mediaOnly = false,
  paywallPrefill = null,
  remixOfTitle = null,
  startingRecipe = 'none',
  leavesOwnUploadsOut = false,
  shareAfterPublish,
  onPublished,
  onFinished,
}: UsePublishCreationOptions) {
  const [isNsfw, setIsNsfw] = useState(false);
  // What the creator typed; null until they do, while the title is the starting one below.
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [publishDescription, setPublishDescription] = useState(() =>
    getDefaultPublishDescription(defaultDescription)
  );
  // The recipe the creator picked; null until they do, while it is the starting one below.
  const [recipeChoice, setRecipeChoice] = useState<PostResourceBundleAccessMode | null>(null);
  const [priceTokens, setPriceTokensState] = useState(String(DEFAULT_RECIPE_PRICE_TOKENS));
  const [publishingVisibility, setPublishingVisibility] = useState<PostVisibility | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [needsProfileRepair, setNeedsProfileRepair] = useState(false);
  const [profile, setProfile] = useState<ProfileApiResponse | null>(null);
  const [profileLoadState, setProfileLoadState] = useState<ProfileLoadState>('idle');
  const { user } = useAuth();
  // The name and handle follow the profile and the sign-in until the creator
  // types; a later answer never puts the starting values back over theirs.
  const [identityEdits, setIdentityEdits] = useState<PublicIdentityDraft | null>(null);
  const [identityErrors, setIdentityErrors] = useState<PublicIdentityErrors>({});
  const identity = identityEdits ?? getInitialPublicIdentity(profile, user);
  // Set by `publish` alone, for as long as its request runs: a second press is refused.
  const isPublishingRef = useRef(false);
  const [addsOwnUploads, setAddsOwnUploadsState] = useState(false);
  const allReferenceCount = Math.max(0, Math.round(paywallPrefill?.referenceCount ?? 0));
  // Not worked out (an older answer): every reference is the creator's own.
  const ownUploadCount = leavesOwnUploadsOut
    ? Math.min(allReferenceCount, Math.max(0, Math.round(paywallPrefill?.ownReferenceCount ?? allReferenceCount)))
    : 0;
  const sharesOwnUploads = !leavesOwnUploadsOut || addsOwnUploads;
  // The recipe without the creator's own uploads, and then, with any of them in the creation,
  // without the remix's hand-over, which would give them all away.
  const prefillWithoutOwn = paywallPrefill && leavesOwnUploadsOut ? withoutOwnUploads(paywallPrefill, ownUploadCount) : paywallPrefill;
  // What the recipe holds as it stands.
  const sharedPrefill = sharesOwnUploads ? paywallPrefill : prefillWithoutOwn;
  const autoUnlockKinds = getAutoUnlockKinds(sharedPrefill);
  // The switch is offered where anything could go, the creator's own uploads included.
  const hasAutoUnlock = showPaidShortcut && Boolean(paywallPrefill) && getAutoUnlockKinds(paywallPrefill).length > 0;
  const generationReferenceCount = Math.max(0, Math.round(sharedPrefill?.referenceCount ?? 0));
  const hasGenerationReferences = generationReferenceCount > 0;
  const otherReferenceCount = allReferenceCount - ownUploadCount;
  // A recipe starts on only where it holds something without the creator's own uploads.
  const startingRecipeAccess: PostResourceBundleAccessMode = hasAutoUnlock && getAutoUnlockKinds(prefillWithoutOwn).length > 0
    ? startingRecipe
    : 'none';
  // The creation's details and the original's answer can arrive after the draft started (the
  // creators read them once a run is done), so the recipe and the title are derived, not copied
  // into state: the switch, the title and a press agree in every render.
  const recipeAccess = recipeChoice ?? startingRecipeAccess;
  // A paid recipe keeps the prompt out of the title; a free one does not (owner, 2026-10-29).
  const promptPrivate = recipeKeepsPromptPrivate(recipeAccess);
  const titleSuggestion = getCreationPostTitleSuggestion(defaultTitle, creation, promptPrivate, remixOfTitle);
  // What an untouched title shows: the creation's own, a title cut from its prompt swapped as
  // the recipe asks, else the suggestion.
  const startingTitle = !titleSuggestion
    ? ''
    : titleSuggestion.source === 'creation'
      ? followCreationTitleSuggestion({ title: titleSuggestion.title, source: creation, wasPrivate: false, isPrivate: promptPrivate })
      : titleSuggestion.title;
  const publishTitle = titleEdit ?? startingTitle;
  const titleSuggestionHint = getCreationTitleSuggestionHint(publishTitle, titleSuggestion, promptPrivate);
  const parsedPriceTokens = parsePriceTokens(priceTokens);
  const isPublishing = publishingVisibility !== null;
  const profileReadiness = getCreatorProfileReadiness(profile);
  // Publishing never requires a profile photo — free and paid recipes alike use
  // the public gate (handle + display name). The avatar is only a
  // profile-completeness nudge, never a blocker.
  const isProfileReadyForPublish = profileReadiness.publicPublishReady;
  // Asked beside the buttons when the profile cannot publish publicly yet, or
  // when the server said so although the check had failed.
  const needsPublicIdentity = needsProfileRepair || (profileLoadState === 'ready' && !isProfileReadyForPublish);

  useEffect(() => {
    if (!active) {
      return;
    }

    // Opening a generation starts a fresh publish draft from its supplied
    // defaults: the title and the recipe go back to the starting ones.
    setIsNsfw(false);
    setTitleEdit(null);
    setPublishDescription(getDefaultPublishDescription(defaultDescription));
    setRecipeChoice(null);
    setPriceTokensState(String(DEFAULT_RECIPE_PRICE_TOKENS));
    setPublishingVisibility(null);
    setFormError(null);
    setNeedsProfileRepair(false);
    setIdentityErrors({});
    setIdentityEdits(null);
    setAddsOwnUploadsState(false);
  }, [defaultDescription, generationId, active]);

  // The profile is the account's: read when the draft opens and for another account, not
  // again for each renewed token, which would put "Checking your profile…" back every hour.
  const accessTokenRef = useRef(accessToken);
  useEffect(() => {
    accessTokenRef.current = accessToken;
  });
  const hasAccessToken = Boolean(accessToken);
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!active || !generationId) {
      return;
    }

    const controller = new AbortController();
    void Promise.resolve()
      .then(async () => {
        if (controller.signal.aborted) {
          return null;
        }

        setProfileLoadState('loading');
        setProfile(null);
        const token = accessTokenRef.current;
        const response = await fetch('/api/profile', {
          cache: 'no-store',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error('Profile could not be checked.');
        }
        return response.json() as Promise<ProfileApiResponse>;
      })
      .then((nextProfile) => {
        if (!nextProfile) {
          return;
        }
        setProfile(nextProfile);
        setProfileLoadState('ready');
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setProfileLoadState('error');
      });

    return () => controller.abort();
  }, [userId, hasAccessToken, generationId, active]);

  const setTitle = (value: string) => {
    setTitleEdit(value);
  };

  const setRecipeAccess = (next: PostResourceBundleAccessMode) => {
    // An untouched title follows the recipe by itself (`startingTitle`); a typed one is swapped
    // only where it is the prompt's opening or a kind title (a paid recipe keeps the prompt private).
    if (titleEdit !== null) {
      setTitleEdit(followCreationTitleSuggestion({
        title: titleEdit,
        source: creation,
        wasPrivate: promptPrivate,
        isPrivate: recipeKeepsPromptPrivate(next),
      }));
    }
    setRecipeChoice(next);
    setFormError(null);
  };

  const setPriceTokens = (value: string) => {
    setPriceTokensState(value);
    setFormError(null);
  };

  const setAddsOwnUploads = (next: boolean) => {
    setAddsOwnUploadsState(next);
    setFormError(null);
  };

  const setIdentity = (next: PublicIdentityDraft) => {
    setIdentityEdits(next);
    setIdentityErrors({});
  };

  /**
   * Publishes the creation as a public or private post. Resolves true once the server has
   * it (and its share has run, where one follows), false when it was refused or not sent.
   */
  const publish = async (nextVisibility: PostVisibility): Promise<boolean> => {
    if (isPublishingRef.current) {
      return false;
    }
    if (!generationId) {
      return false;
    }

    const savesIdentity = nextVisibility === 'public' && needsPublicIdentity;
    if (savesIdentity) {
      const localErrors = validatePublicIdentity(identity, profile?.username);
      if (localErrors.displayName || localErrors.username) {
        setIdentityErrors(localErrors);
        setFormError('Add your name and handle to publish publicly.');
        return false;
      }
    }

    let resourceBundle: PostResourceBundleInput | null = mediaOnly ? null : { accessMode: 'none' };
    if (recipeAccess !== 'none') {
      if (!sharedPrefill || autoUnlockKinds.length === 0) {
        setFormError(leavesOwnUploadsOut && !addsOwnUploads && ownUploadCount > 0
          ? 'Without your own uploads this recipe holds nothing yet. Add them, or turn the recipe off.'
          : 'This creation does not have enough saved setup to make a recipe from yet.');
        return false;
      }

      // Free recipes carry no price; only the paid mode has a floor to enforce.
      let priceUsdCents = 0;
      if (recipeAccess === 'paid') {
        if (
          parsedPriceTokens === null
          || parsedPriceTokens < POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS
          || parsedPriceTokens % POST_RESOURCE_PRICE_INCREMENT_USD_CENTS !== 0
        ) {
          setFormError(
            `Paid recipes start at ${POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS} credits, in steps of ${POST_RESOURCE_PRICE_INCREMENT_USD_CENTS}.`,
          );
          return false;
        }
        priceUsdCents = parsedPriceTokens;
      }

      resourceBundle = buildAutoResourceBundle({
        prefill: sharedPrefill,
        accessMode: recipeAccess,
        priceUsdCents,
      });
    }

    isPublishingRef.current = true;
    setPublishingVisibility(nextVisibility);
    setFormError(null);

    try {
      if (savesIdentity) {
        const saved = await claimPublicIdentity(identity, accessToken);
        if (!saved.ok) {
          setIdentityErrors(saved.errors);
          setFormError(saved.message);
          return false;
        }
        setProfile(saved.profile);
        setIdentityErrors({});
        setNeedsProfileRepair(false);
      }

      const requestBody: {
        generationId: string;
        isNsfw?: boolean;
        visibility: PostVisibility;
        title?: string;
        description?: string;
        shareInputMediaForRemix: boolean;
        includeGenerationReferences?: boolean;
        leaveOutOwnGenerationReferences?: boolean;
        resourceBundle?: PostResourceBundleInput;
      } = {
        generationId,
        ...(isNsfw ? { isNsfw: true } : {}),
        visibility: nextVisibility,
        title: normalizeOptionalText(publishTitle),
        description: normalizeOptionalText(publishDescription),
        shareInputMediaForRemix: false,
      };

      if (hasGenerationReferences && resourceBundle?.accessMode !== 'none') {
        requestBody.includeGenerationReferences = true;
      }
      // The server holds the same line: only the original's references, and no hand-over
      // where any of the creator's own are in the creation.
      if (!sharesOwnUploads && resourceBundle && resourceBundle.accessMode !== 'none') {
        requestBody.leaveOutOwnGenerationReferences = true;
      }

      if (resourceBundle) {
        requestBody.resourceBundle = resourceBundle;
      }

      const response = await fetch('/api/showcase/publish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken
            ? {
                Authorization: `Bearer ${accessToken}`,
              }
            : {}),
        },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json() as {
        success?: boolean;
        error?: string;
        field?: string;
        visibility?: PostVisibility;
        resourceBundleStatus?: 'draft' | 'published' | null;
        resourceBundlePath?: string | null;
        postId?: string | null;
        showcasePath?: string | null;
        ownerPath?: string | null;
      };
      if (!response.ok || !data.success) {
        if (data.field === 'profile') {
          setNeedsProfileRepair(true);
        }
        throw new Error(data.error || 'Failed to publish');
      }

      const normalizedTitle = publishTitle.trim();
      const normalizedDescription = publishDescription.trim();

      onPublished?.({
        title: normalizedTitle,
        description: normalizedDescription,
        visibility: data.visibility,
        resourceBundleStatus: data.resourceBundleStatus ?? null,
        resourceBundlePath: data.resourceBundlePath ?? null,
        postId: data.postId ?? null,
        showcasePath: data.showcasePath ?? null,
        ownerPath: data.ownerPath ?? null,
      });

      if (shareAfterPublish && nextVisibility === 'public') {
        try {
          await sharePublicGeneration({
            generationId,
            title: normalizedTitle || shareAfterPublish.title,
            description: normalizedDescription || shareAfterPublish.description || null,
            sourceSurface: shareAfterPublish.sourceSurface,
            accessToken,
            viewerIsOwner: true,
          });
        } catch (shareError) {
          // Publishing is already complete. A canceled or unavailable share
          // action must never be reported as a failed publish.
          console.error('Published generation, but sharing was unavailable:', shareError);
        }
      }

      onFinished?.();
      return true;
    } catch (error) {
      console.error('Failed to publish generation:', error);
      setFormError(error instanceof Error ? error.message : 'Failed to publish');
      return false;
    } finally {
      isPublishingRef.current = false;
      setPublishingVisibility(null);
    }
  };

  return {
    isNsfw,
    setIsNsfw,
    title: publishTitle,
    setTitle,
    titleSuggestionHint,
    description: publishDescription,
    setDescription: setPublishDescription,
    recipeAccess,
    setRecipeAccess,
    priceTokens,
    setPriceTokens,
    parsedPriceTokens,
    autoUnlockKinds,
    hasAutoUnlock,
    generationReferenceCount,
    hasGenerationReferences,
    ownUploadCount,
    otherReferenceCount,
    ownUploadKindCounts: leavesOwnUploadsOut ? paywallPrefill?.ownReferenceKindCounts ?? paywallPrefill?.referenceKindCounts ?? null : null,
    addsOwnUploads,
    setAddsOwnUploads,
    identity,
    identityErrors,
    setIdentity,
    needsPublicIdentity,
    profile,
    profileLoadState,
    formError,
    publishingVisibility,
    isPublishing,
    isPublishingRef,
    publish,
  };
}

export type PublishCreationDraft = ReturnType<typeof usePublishCreation>;
