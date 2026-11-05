'use client';

import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@/components/AuthProvider';
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
  type PostResourceBundleInput,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
// The posting defaults both composers and this form share (remix plan, phase 2; owner, 2026-11-05).
import {
  CREATION_RECIPE_STARTING_ACCESS,
  DEFAULT_PAID_RECIPE_PRICE_CREDITS,
  remixRecipeLock,
  type GenerationReference,
  type RemixRecipeMode,
} from '../../ugc-mobile/lib/creation-recipe/creation-recipe';

/**
 * The creators' publish form on the canvas (the artboard Result): the draft (title and its
 * suggestion, the name and handle a first post saves, the recipe, NSFW), the request to
 * `/api/showcase/publish`, its errors and what it answers all live here, and the form only
 * draws them. Studio and template runs open the full composer (`/post/new`) instead, as the
 * app does.
 */

/** A post is public or private (decision 12, 2026-10-17); the server answers no other. */
export type PostVisibility = 'public' | 'private';
type ProfileLoadState = 'idle' | 'loading' | 'ready' | 'error';
/**
 * The recipe the form posts (owner, 2026-11-05: a creation's post always carries one): free, or
 * paid at the starting price where the run remixed a paid recipe, whose terms it keeps; none only
 * for a creation with nothing to share. Another price is the composer's (More options).
 */
type CreationRecipeAccess = 'none' | 'free' | 'paid';

/** What a publish answers, as the page that asked keeps it. */
export type PublishedCreation = {
  title: string;
  visibility?: PostVisibility;
  resourceBundleStatus?: 'draft' | 'published' | null;
  resourceBundlePath?: string | null;
  postId?: string | null;
  showcasePath?: string | null;
  ownerPath?: string | null;
};

const RESOURCE_KIND_ORDER: PostResourceKind[] = ['prompt', 'workflow', 'files', 'notes', 'remix'];
const NO_INPUTS: readonly GenerationReference[] = [];

function normalizeOptionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * What the shared recipe holds: the prompt, the creation's references and its remix. Never its
 * settings, which its post shows everyone (owner, 2026-11-03): the prefill carries none
 * (`readGenerationPaywallPrefill` leaves an older answer's notes out).
 */
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
  if (prefill.allowRemix) {
    kinds.add('remix');
  }

  return RESOURCE_KIND_ORDER.filter((kind) => kinds.has(kind));
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

/**
 * The recipe packed from what the creation saved: its prompt, its references and its remix, free or
 * at the starting price. `handsOverInputs` is the creation's inputs handed to a remix as they are
 * (`allowRemix`), which a recipe the creator took any file out of never does: a remix then restores
 * the copies the recipe holds, and nothing they removed.
 */
function buildAutoResourceBundle(
  prefill: GenerationPaywallPrefill,
  accessMode: 'free' | 'paid',
  handsOverInputs: boolean,
): PostResourceBundleInput {
  const kinds = getAutoUnlockKinds(prefill);

  return {
    accessMode,
    summary: buildAutoUnlockSummary(kinds),
    previewText: buildAutoUnlockPreview(kinds),
    priceUsdCents: accessMode === 'paid' ? DEFAULT_PAID_RECIPE_PRICE_CREDITS : 0,
    resources: {
      promptText: prefill.promptText?.trim() || null,
      workflowShareUrl: null,
      attachments: [],
      allowRemix: handsOverInputs,
    },
  };
}

export interface UsePublishCreationOptions {
  /** The form is on the canvas: a fresh draft starts each time it becomes so. */
  active: boolean;
  generationId: string | null;
  accessToken?: string | null;
  defaultTitle?: string;
  /**
   * The creation's prompt, model and category, from which a title is
   * suggested when it has none of its own (`defaultTitle`).
   */
  creation?: CreationTitleSource | null;
  paywallPrefill?: GenerationPaywallPrefill | null;
  /**
   * The creation's saved inputs the recipe takes (`recipeCopyableInputs`), the creator's own uploads
   * included (owner, 2026-11-05), each drawn with a remove button.
   */
  inputs?: readonly GenerationReference[];
  /** The terms the run carries as a remix (`remix_recipe_mode`): its recipe is held to them. */
  remixRecipeMode?: RemixRecipeMode | null;
  /** The title of the post a remix was made from: an untitled remix starts from it ("intense (remix)"). */
  remixOfTitle?: string | null;
  onPublished?: (payload: PublishedCreation) => void;
}

export function usePublishCreation({
  active,
  generationId,
  accessToken = null,
  defaultTitle = '',
  creation = null,
  paywallPrefill = null,
  inputs = NO_INPUTS,
  remixRecipeMode = null,
  remixOfTitle = null,
  onPublished,
}: UsePublishCreationOptions) {
  const [isNsfw, setIsNsfw] = useState(false);
  // What the creator typed; null until they do, while the title is the starting one below.
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  // The saved inputs the creator took out of the recipe, by id.
  const [removedInputIds, setRemovedInputIds] = useState<ReadonlySet<string>>(() => new Set());
  // "Allow remixes" (owner, 2026-11-05), on by default.
  const [allowRemixes, setAllowRemixesState] = useState(true);
  const [isPublishing, setIsPublishing] = useState(false);
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
  // The files the recipe takes as it stands: the saved inputs but those the creator removed.
  const includedInputs = inputs.filter((input) => !removedInputIds.has(input.id));
  const removedInputs = inputs.filter((input) => removedInputIds.has(input.id));
  // What the recipe holds as it stands: its files counted as the inputs left in it, and its remix
  // as the switch says (each creation post's recipe comes with its Remix since 2026-10-27).
  const sharedPrefill: GenerationPaywallPrefill | null = paywallPrefill
    ? {
      ...paywallPrefill,
      referenceCount: inputs.length > 0 ? includedInputs.length : paywallPrefill.referenceCount,
      allowRemix: allowRemixes,
      resourceKinds: paywallPrefill.resourceKinds.filter((kind) => (
        (kind !== 'files' || (inputs.length > 0 ? includedInputs.length > 0 : (paywallPrefill.referenceCount ?? 0) > 0))
        && (kind !== 'remix' || allowRemixes)
      )),
    }
    : null;
  const autoUnlockKinds = getAutoUnlockKinds(sharedPrefill);
  // Anything to share at all: a prompt, a saved input, a remix.
  const hasAutoUnlock = Boolean(paywallPrefill) && getAutoUnlockKinds(paywallPrefill).length > 0;
  const hasGenerationReferences = inputs.length > 0
    ? includedInputs.length > 0
    : Math.max(0, Math.round(paywallPrefill?.referenceCount ?? 0)) > 0;
  // A creation's post always carries its recipe: free, or paid where the run remixed a paid recipe
  // (whose terms it keeps, at the starting price); none only for a creation with nothing to share.
  const lock = remixRecipeLock(remixRecipeMode);
  const recipeAccess: CreationRecipeAccess = hasAutoUnlock
    ? lock?.accessMode ?? CREATION_RECIPE_STARTING_ACCESS
    : 'none';
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
    setIsPublishing(false);
    setFormError(null);
    setNeedsProfileRepair(false);
    setIdentityErrors({});
    setIdentityEdits(null);
    setRemovedInputIds(new Set());
    setAllowRemixesState(true);
  }, [generationId, active]);

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

  // An untouched title follows the recipe by itself (`startingTitle`); a typed one is swapped
  // only where it is the prompt's opening or a kind title, when a late answer turns the recipe paid.
  const typedTitleFollowsRecipe = useRef(promptPrivate);
  useEffect(() => {
    if (typedTitleFollowsRecipe.current === promptPrivate) return;
    const wasPrivate = typedTitleFollowsRecipe.current;
    typedTitleFollowsRecipe.current = promptPrivate;
    setTitleEdit((typed) => (typed === null ? typed : followCreationTitleSuggestion({
      title: typed,
      source: creation,
      wasPrivate,
      isPrivate: promptPrivate,
    })));
  }, [promptPrivate, creation]);

  /** Takes a saved input out of the recipe, or puts it back. */
  const setInputIncluded = (inputId: string, included: boolean) => {
    setRemovedInputIds((current) => {
      const next = new Set(current);
      if (included) next.delete(inputId); else next.add(inputId);
      return next;
    });
    setFormError(null);
  };

  const setAllowRemixes = (next: boolean) => {
    setAllowRemixesState(next);
    setFormError(null);
  };

  const setIdentity = (next: PublicIdentityDraft) => {
    setIdentityEdits(next);
    setIdentityErrors({});
  };

  /**
   * Publishes the creation as a public post. Resolves true once the server has it, false
   * when it was refused or not sent.
   */
  const publish = async (): Promise<boolean> => {
    if (isPublishingRef.current) {
      return false;
    }
    if (!generationId) {
      return false;
    }

    const savesIdentity = needsPublicIdentity;
    if (savesIdentity) {
      const localErrors = validatePublicIdentity(identity, profile?.username);
      if (localErrors.displayName || localErrors.username) {
        setIdentityErrors(localErrors);
        setFormError('Add your name and handle to publish publicly.');
        return false;
      }
    }

    let resourceBundle: PostResourceBundleInput = { accessMode: 'none' };
    if (recipeAccess !== 'none') {
      if (!sharedPrefill || autoUnlockKinds.length === 0) {
        setFormError(removedInputs.length > 0
          ? 'This recipe holds nothing now. Put a file back, or allow remixes.'
          : 'This creation has no saved prompt or references to make a recipe from yet.');
        return false;
      }

      // The creation's inputs go to a remix as they are only where the creator removed none.
      resourceBundle = buildAutoResourceBundle(
        sharedPrefill,
        recipeAccess,
        Boolean(paywallPrefill?.allowRemix) && removedInputs.length === 0,
      );
    }

    isPublishingRef.current = true;
    setIsPublishing(true);
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
        shareInputMediaForRemix: boolean;
        includeGenerationReferences?: boolean;
        leaveOutGenerationReferenceIds?: string[];
        allowRemixes: boolean;
        resourceBundle: PostResourceBundleInput;
      } = {
        generationId,
        ...(isNsfw ? { isNsfw: true } : {}),
        visibility: 'public',
        title: normalizeOptionalText(publishTitle),
        shareInputMediaForRemix: false,
        // Sent every time: the server reads it as a form that offers no post without a recipe.
        allowRemixes,
        resourceBundle,
      };

      if (hasGenerationReferences && resourceBundle.accessMode !== 'none') {
        requestBody.includeGenerationReferences = true;
      }
      // The server copies none of these, whatever else asks.
      if (removedInputs.length > 0 && resourceBundle.accessMode !== 'none') {
        requestBody.leaveOutGenerationReferenceIds = removedInputs.map((input) => input.id);
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

      onPublished?.({
        title: publishTitle.trim(),
        visibility: data.visibility,
        resourceBundleStatus: data.resourceBundleStatus ?? null,
        resourceBundlePath: data.resourceBundlePath ?? null,
        postId: data.postId ?? null,
        showcasePath: data.showcasePath ?? null,
        ownerPath: data.ownerPath ?? null,
      });

      return true;
    } catch (error) {
      console.error('Failed to publish generation:', error);
      setFormError(error instanceof Error ? error.message : 'Failed to publish');
      return false;
    } finally {
      isPublishingRef.current = false;
      setIsPublishing(false);
    }
  };

  return {
    isNsfw,
    setIsNsfw,
    title: publishTitle,
    setTitle,
    titleSuggestionHint,
    recipeAccess,
    /** The terms a remix's recipe is held to, with why; null for a creation that remixed no one's. */
    recipeLock: lock,
    /** The price a paid recipe goes out at from here; another is the composer's. */
    paidPriceCredits: DEFAULT_PAID_RECIPE_PRICE_CREDITS,
    hasAutoUnlock,
    /** The creation saved a prompt for the recipe to share (a motion run saves none). */
    hasPrompt: Boolean(paywallPrefill?.promptText?.trim()),
    inputs,
    includedInputs,
    setInputIncluded,
    allowRemixes,
    setAllowRemixes,
    identity,
    identityErrors,
    setIdentity,
    needsPublicIdentity,
    profile,
    profileLoadState,
    formError,
    isPublishing,
    isPublishingRef,
    publish,
  };
}

export type PublishCreationDraft = ReturnType<typeof usePublishCreation>;
