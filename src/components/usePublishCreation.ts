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
/** The form shares a recipe free, or none; a price is the composer's (More options). */
type CreationRecipeAccess = 'none' | 'free';

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

function normalizeOptionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
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

/** The free recipe packed from the creation's saved setup. */
function buildAutoResourceBundle(prefill: GenerationPaywallPrefill): PostResourceBundleInput {
  const kinds = getAutoUnlockKinds(prefill);

  return {
    accessMode: 'free',
    summary: buildAutoUnlockSummary(kinds),
    previewText: buildAutoUnlockPreview(kinds),
    priceUsdCents: 0,
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
  /** The title of the post a remix was made from: an untitled remix starts from it ("intense (remix)"). */
  remixOfTitle?: string | null;
  /**
   * The recipe a fresh draft starts with where the creation has one to offer: none unless
   * asked, for the creator to opt in; the creators' form asks for a free one (owner,
   * 2026-10-28). Until the creator picks one themselves, a prefill arriving late sets it too.
   */
  startingRecipe?: 'none' | 'free';
  /**
   * The recipe leaves the creator's own uploads out until they add them (the creators' form,
   * owner 2026-10-29): only the references a remix brought from its original go in, and with
   * any of their own in the creation none is handed to a remix. Otherwise it shares them all.
   */
  leavesOwnUploadsOut?: boolean;
  onPublished?: (payload: PublishedCreation) => void;
}

export function usePublishCreation({
  active,
  generationId,
  accessToken = null,
  defaultTitle = '',
  creation = null,
  paywallPrefill = null,
  remixOfTitle = null,
  startingRecipe = 'none',
  leavesOwnUploadsOut = false,
  onPublished,
}: UsePublishCreationOptions) {
  const [isNsfw, setIsNsfw] = useState(false);
  // What the creator typed; null until they do, while the title is the starting one below.
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  // The recipe the creator picked; null until they do, while it is the starting one below.
  const [recipeChoice, setRecipeChoice] = useState<CreationRecipeAccess | null>(null);
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
  const hasAutoUnlock = Boolean(paywallPrefill) && getAutoUnlockKinds(paywallPrefill).length > 0;
  const generationReferenceCount = Math.max(0, Math.round(sharedPrefill?.referenceCount ?? 0));
  const hasGenerationReferences = generationReferenceCount > 0;
  const otherReferenceCount = allReferenceCount - ownUploadCount;
  // A recipe starts on only where it holds something without the creator's own uploads.
  const startingRecipeAccess: CreationRecipeAccess = hasAutoUnlock && getAutoUnlockKinds(prefillWithoutOwn).length > 0
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
    setRecipeChoice(null);
    setIsPublishing(false);
    setFormError(null);
    setNeedsProfileRepair(false);
    setIdentityErrors({});
    setIdentityEdits(null);
    setAddsOwnUploadsState(false);
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

  const setRecipeAccess = (next: CreationRecipeAccess) => {
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

  const setAddsOwnUploads = (next: boolean) => {
    setAddsOwnUploadsState(next);
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
        setFormError(leavesOwnUploadsOut && !addsOwnUploads && ownUploadCount > 0
          ? 'Without your own uploads this recipe holds nothing yet. Add them, or turn the recipe off.'
          : 'This creation does not have enough saved setup to make a recipe from yet.');
        return false;
      }

      resourceBundle = buildAutoResourceBundle(sharedPrefill);
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
        leaveOutOwnGenerationReferences?: boolean;
        resourceBundle: PostResourceBundleInput;
      } = {
        generationId,
        ...(isNsfw ? { isNsfw: true } : {}),
        visibility: 'public',
        title: normalizeOptionalText(publishTitle),
        shareInputMediaForRemix: false,
        resourceBundle,
      };

      if (hasGenerationReferences && resourceBundle.accessMode !== 'none') {
        requestBody.includeGenerationReferences = true;
      }
      // The server holds the same line: only the original's references, and no hand-over
      // where any of the creator's own are in the creation.
      if (!sharesOwnUploads && resourceBundle.accessMode !== 'none') {
        requestBody.leaveOutOwnGenerationReferences = true;
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
    setRecipeAccess,
    hasAutoUnlock,
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
    isPublishing,
    isPublishingRef,
    publish,
  };
}

export type PublishCreationDraft = ReturnType<typeof usePublishCreation>;
