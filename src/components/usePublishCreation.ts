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
  creationRecipeHasItems,
  creationRecipeStart,
  remixRecipeLock,
  remixRecipeRequired,
  type GenerationReference,
  type OwnSourceRecipe,
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
 * paid where the run remixed a paid recipe, whose terms it keeps, or where it came from the
 * creator's own paid post (owner, 2026-11-06); none only for a creation with nothing to share.
 * Another price is the composer's (More options).
 */
export type CreationRecipeAccess = 'none' | 'free' | 'paid';

/** What a publish answers, as the page that asked keeps it. */
export type PublishedCreation = {
  title: string;
  visibility?: PostVisibility;
  resourceBundleStatus?: 'draft' | 'published' | null;
  resourceBundlePath?: string | null;
  postId?: string | null;
  showcasePath?: string | null;
  ownerPath?: string | null;
  /** The recipe it went out with, so Posted says free or paid as it is (#711's review). */
  recipeAccess?: CreationRecipeAccess;
  /** Its "Allow remixes": off, Posted promises no alert of a remix. */
  allowRemixes?: boolean;
};

const NO_INPUTS: readonly GenerationReference[] = [];

function normalizeOptionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * What the shared recipe holds, in the order a listing names it: the prompt, the files left in it
 * and its remix while remixes are allowed. Never the creation's settings, which its post shows
 * everyone (owner, 2026-11-03).
 */
function getRecipeKinds({ hasPrompt, hasFiles, allowRemixes }: {
  hasPrompt: boolean;
  hasFiles: boolean;
  allowRemixes: boolean;
}): PostResourceKind[] {
  return [
    ...(hasPrompt ? ['prompt' as const] : []),
    ...(hasFiles ? ['files' as const] : []),
    ...(allowRemixes ? ['remix' as const] : []),
  ];
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
 * at its price. It hands none of the creation's inputs over as they are (`allowRemix`): the recipe
 * holds copies of those it shares, a remix restores the copies, and a file the creator removes, now
 * or on a later edit, stays out (owner, 2026-11-05).
 */
function buildAutoResourceBundle({ promptText, kinds, accessMode, priceCredits }: {
  promptText: string | null;
  kinds: PostResourceKind[];
  accessMode: 'free' | 'paid';
  priceCredits: number;
}): PostResourceBundleInput {
  return {
    accessMode,
    summary: buildAutoUnlockSummary(kinds),
    previewText: buildAutoUnlockPreview(kinds),
    priceUsdCents: accessMode === 'paid' ? priceCredits : 0,
    resources: {
      promptText,
      workflowShareUrl: null,
      attachments: [],
      allowRemix: false,
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
  /**
   * The recipe on the creator's own post the creation came from: a paid one starts this one Paid at
   * its price, which the creator may still make Free (owner, 2026-11-06, "Start Paid, can switch").
   */
  ownSourceRecipe?: OwnSourceRecipe | null;
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
  ownSourceRecipe = null,
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
  // Free or Paid as the creator chose it, where the start is theirs to change: a recipe that starts
  // paid from their own post's (owner, 2026-11-06). Null until they do.
  const [accessChoice, setAccessChoice] = useState<'free' | 'paid' | null>(null);
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
  const promptText = paywallPrefill?.promptText?.trim() || null;
  // What the recipe can hold as it stands (#711's review): the prompt, or a saved input the server
  // copies that is still in it. A remix is no item of a recipe, and the references a remix keeps in
  // its original's folder are never copied, so neither makes one: a creation with neither posts its
  // media alone, and the form says how to put a removed file back.
  const recipeHasItems = Boolean(paywallPrefill) && creationRecipeHasItems(promptText, inputs, removedInputIds);
  // A remix of a paid recipe has no media alone to fall back to: its public post holds a paid
  // recipe or nothing (`remixRecipeRequired`), so an empty one is refused here with the way on.
  const carriesRecipe = recipeHasItems || remixRecipeRequired(remixRecipeMode);
  const kinds = getRecipeKinds({ hasPrompt: Boolean(promptText), hasFiles: includedInputs.length > 0, allowRemixes });
  // Where the recipe starts (owner, 2026-11-05 and 2026-11-06): held to a remix's terms, paid at
  // the creator's own post's price where that recipe is paid, else free.
  const start = creationRecipeStart(remixRecipeMode, ownSourceRecipe);
  const lock = start.locked ? remixRecipeLock(remixRecipeMode) : null;
  const recipeAccess: CreationRecipeAccess = !carriesRecipe
    ? 'none'
    : start.locked ? start.accessMode : accessChoice ?? start.accessMode;
  // A recipe that starts paid from the creator's own post's may be made free, and paid again.
  const offersPaidChoice = carriesRecipe && !start.locked && start.accessMode === 'paid';
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
    setAccessChoice(null);
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

  /** Puts every removed input back into the recipe. */
  const restoreRemovedInputs = () => {
    setRemovedInputIds(new Set());
    setFormError(null);
  };

  const setAllowRemixes = (next: boolean) => {
    setAllowRemixesState(next);
    setFormError(null);
  };

  /** Sells the recipe or shares it free, where that is the creator's to choose (`offersPaidChoice`). */
  const setRecipePaid = (paid: boolean) => {
    setAccessChoice(paid ? 'paid' : 'free');
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

    // A recipe holds the prompt or a file; with neither, the media goes alone, but a remix of a paid
    // recipe must go with a paid one, so its empty recipe is refused with the way on.
    if (recipeAccess !== 'none' && !recipeHasItems) {
      setFormError(removedInputs.length > 0
        ? 'This recipe holds nothing now. Put a file back to share it.'
        : 'This creation has no saved prompt or references to make a recipe from yet. Add an item in More options.');
      return false;
    }
    // No live input is handed over (owner, 2026-11-05): the recipe holds copies of the inputs it
    // shares, and a remix restores those, so a file removed now or on a later edit stays out.
    const resourceBundle: PostResourceBundleInput = recipeAccess === 'none'
      ? { accessMode: 'none' }
      : buildAutoResourceBundle({ promptText, kinds, accessMode: recipeAccess, priceCredits: start.priceCredits });
    const sendsRecipe = resourceBundle.accessMode !== 'none';

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
        allowRemixes?: boolean;
        resourceBundle: PostResourceBundleInput;
      } = {
        generationId,
        ...(isNsfw ? { isNsfw: true } : {}),
        visibility: 'public',
        title: normalizeOptionalText(publishTitle),
        shareInputMediaForRemix: false,
        // Sent with a recipe, where the panel draws the switch: the server reads it as a form that
        // offers no post without one. The media alone (nothing to share, every file removed from a
        // creation with no prompt, or the details unread) leaves it out, and the post allows remixes.
        ...(sendsRecipe ? { allowRemixes } : {}),
        resourceBundle,
      };

      if (sendsRecipe && includedInputs.length > 0) {
        requestBody.includeGenerationReferences = true;
      }
      // The server copies none of these, whatever else asks.
      if (sendsRecipe && removedInputs.length > 0) {
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
        recipeAccess: resourceBundle.accessMode === 'paid' ? 'paid' : resourceBundle.accessMode === 'free' ? 'free' : 'none',
        // Without the switch the server keeps the post open to remixes.
        allowRemixes: sendsRecipe ? allowRemixes : true,
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
    /** The price a paid recipe goes out at from here: its own post's, else the starting one. Another is the composer's. */
    paidPriceCredits: start.priceCredits,
    /** The recipe starts paid from the creator's own post's, and they may share it free (owner, 2026-11-06). */
    offersPaidChoice,
    setRecipePaid,
    /** The creation saved a prompt for the recipe to share (a motion run saves none). */
    hasPrompt: Boolean(promptText),
    inputs,
    includedInputs,
    /** The saved inputs the creator took out, which "More options" carries over (#711's review). */
    removedInputIds: removedInputs.map((input) => input.id),
    setInputIncluded,
    restoreRemovedInputs,
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
