'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { BadgeDollarSign, BookOpen, Check, CircleAlert, Globe, Loader2, LockKeyhole, Share2, UserRound, X } from 'lucide-react';

import { sharePublicGeneration } from '@/lib/share-client';
import type { GenerationShareSourceSurface } from '@/lib/share';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import { getCreatorProfileReadiness, type ProfileApiResponse } from '@/lib/profile';
import {
  formatUsdCents,
  getPostResourceKindLabel,
  POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS,
  POST_RESOURCE_PRICE_INCREMENT_USD_CENTS,
  type PersistedPostResourceBundleAccessMode,
  type PostResourceBundleAccessMode,
  type PostResourceBundleInput,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';

type PostVisibility = 'public' | 'unlisted' | 'private';
type ProfileLoadState = 'idle' | 'loading' | 'ready' | 'error';

const RESOURCE_KIND_ORDER: PostResourceKind[] = ['prompt', 'workflow', 'files', 'notes', 'remix'];

/**
 * The three access modes are shown side by side on purpose. Collapsing them
 * into a single "sell this" checkbox hid `free` entirely: unchecking it
 * published no recipe at all rather than a free one.
 */
const RECIPE_ACCESS_OPTIONS: ReadonlyArray<{
  value: PostResourceBundleAccessMode;
  label: string;
  hint: string;
}> = [
  {
    value: 'none',
    label: 'Off',
    hint: 'Only the media is published. Your prompt, files, and notes stay private.',
  },
  {
    value: 'free',
    label: 'Free',
    hint: 'Anyone can add this recipe to their library with one tap. Great for building a following.',
  },
  {
    value: 'paid',
    label: 'Paid',
    hint: 'Buyers see the price before paying. Until then only the summary and resource types are public.',
  },
];

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

const DEFAULT_PRICE_TOKENS = 900;

/**
 * Prices are token counts. `price_usd_cents` stores the token value directly --
 * at the fixed 100-token/$1 rate the two numbers are the same.
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

function formatReferenceCountLabel(count: number): string {
  return count === 1 ? '1 reference included' : `${count} references included`;
}

function buildAutoUnlockSummary(kinds: PostResourceKind[]): string {
  if (kinds.length === 0) {
    return 'Saved creation setup';
  }

  if (kinds.length === 1) {
    return `${getPostResourceKindLabel(kinds[0])} from this creation`;
  }

  const labels = kinds.map((kind) => getPostResourceKindLabel(kind).toLowerCase());
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]} from this creation`;
}

function buildAutoUnlockPreview(kinds: PostResourceKind[]): string {
  if (kinds.length === 0) {
    return 'Unlock the saved system details behind this generated media.';
  }

  const labels = kinds.map((kind) => getPostResourceKindLabel(kind).toLowerCase());
  return `Unlock the saved ${labels.join(', ')} used to create this result.`;
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

interface PublishToShowcaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  generationId: string | null;
  accessToken?: string | null;
  defaultTitle?: string;
  defaultDescription?: string;
  showPaidShortcut?: boolean;
  mediaOnly?: boolean;
  paywallPrefill?: GenerationPaywallPrefill | null;
  shareAfterPublish?: {
    title: string;
    description?: string | null;
    sourceSurface: GenerationShareSourceSurface;
  };
  onPublished?: (payload: {
    title: string;
    description: string;
    visibility?: PostVisibility;
    resourceBundleStatus?: 'draft' | 'published' | null;
    resourceBundlePath?: string | null;
    postId?: string | null;
    showcasePath?: string | null;
    ownerPath?: string | null;
  }) => void;
}

export default function PublishToShowcaseModal({
  isOpen,
  onClose,
  generationId,
  accessToken = null,
  defaultTitle = '',
  defaultDescription = '',
  showPaidShortcut = true,
  mediaOnly = false,
  paywallPrefill = null,
  shareAfterPublish,
  onPublished,
}: PublishToShowcaseModalProps) {
  const [publishTitle, setPublishTitle] = useState(defaultTitle);
  const [publishDescription, setPublishDescription] = useState(() =>
    getDefaultPublishDescription(defaultDescription)
  );
  const [recipeAccess, setRecipeAccess] = useState<PostResourceBundleAccessMode>('none');
  const [priceTokens, setPriceTokens] = useState(String(DEFAULT_PRICE_TOKENS));
  const [publishingVisibility, setPublishingVisibility] = useState<PostVisibility | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [needsProfileRepair, setNeedsProfileRepair] = useState(false);
  const [profile, setProfile] = useState<ProfileApiResponse | null>(null);
  const [profileLoadState, setProfileLoadState] = useState<ProfileLoadState>('idle');
  const [profileRefreshRevision, setProfileRefreshRevision] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const isPublishingRef = useRef(false);
  const profileRepairHref = '/profile?source=quick-publish';
  const autoUnlockKinds = getAutoUnlockKinds(paywallPrefill);
  const hasAutoUnlock = showPaidShortcut && Boolean(paywallPrefill) && autoUnlockKinds.length > 0;
  const generationReferenceCount = Math.max(0, Math.round(paywallPrefill?.referenceCount ?? 0));
  const hasGenerationReferences = generationReferenceCount > 0;
  const isPaidRecipe = recipeAccess === 'paid';
  const activeAccessIndex = Math.max(
    0,
    RECIPE_ACCESS_OPTIONS.findIndex((option) => option.value === recipeAccess)
  );
  const parsedPriceTokens = parsePriceTokens(priceTokens);
  const isPublishing = publishingVisibility !== null;
  const profileReadiness = getCreatorProfileReadiness(profile);
  // Only a paid recipe requires the stricter seller profile. A free recipe is a
  // public post that happens to carry its setup, so it uses the public gate.
  const willSellRecipe = isPaidRecipe;
  const isProfileReadyForPublish = willSellRecipe
    ? profileReadiness.sellerReady
    : profileReadiness.publicPublishReady;
  const recipeAccessBadgeLabel = recipeAccess === 'none'
    ? 'No recipe'
    : recipeAccess === 'free'
      ? 'Free recipe'
      : parsedPriceTokens !== null && parsedPriceTokens >= POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS
        ? `${parsedPriceTokens} token recipe`
        : 'Paid recipe';

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    isPublishingRef.current = isPublishing;
  }, [isPublishing]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // Opening a generation starts a fresh publish draft from its supplied defaults.
    setPublishTitle(defaultTitle);
    setPublishDescription(getDefaultPublishDescription(defaultDescription));
    // A fresh publish starts with no recipe attached; the creator opts in.
    setRecipeAccess('none');
    setPriceTokens(String(DEFAULT_PRICE_TOKENS));
    setPublishingVisibility(null);
    setFormError(null);
    setNeedsProfileRepair(false);
  }, [defaultDescription, defaultTitle, generationId, isOpen]);

  useEffect(() => {
    if (!isOpen || !generationId) {
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
        const response = await fetch('/api/profile', {
          cache: 'no-store',
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
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
  }, [accessToken, generationId, isOpen, profileRefreshRevision]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const refreshProfileAfterRepair = () => {
      setProfileRefreshRevision((current) => current + 1);
    };

    window.addEventListener('focus', refreshProfileAfterRepair);
    return () => window.removeEventListener('focus', refreshProfileAfterRepair);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !generationId) {
      return;
    }

    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() => titleInputRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!isPublishingRef.current) {
          onCloseRef.current();
        }
        return;
      }

      if (event.key !== 'Tab' || !dialogRef.current) {
        return;
      }

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter((element) => !element.hasAttribute('hidden'));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      const focusTarget = previouslyFocusedRef.current;
      window.queueMicrotask(() => {
        if (focusTarget?.isConnected) {
          focusTarget.focus();
        }
      });
    };
  }, [generationId, isOpen]);

  if (!isOpen || !generationId) {
    return null;
  }

  const handleFormSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handleQuickPublish('public');
  };

  const handleQuickPublish = async (nextVisibility: Extract<PostVisibility, 'public' | 'private'>) => {
    if (isPublishing) {
      return;
    }

    if (nextVisibility === 'public' && profileLoadState === 'ready' && !isProfileReadyForPublish) {
      setNeedsProfileRepair(true);
      setFormError(
        willSellRecipe
          ? 'Complete your profile before selling a recipe: choose a custom handle, add your display name, and upload a profile photo.'
          : 'Complete your profile before publishing publicly: choose a custom handle and add your display name.'
      );
      return;
    }

    let resourceBundle: PostResourceBundleInput | null = mediaOnly ? null : { accessMode: 'none' };
    if (recipeAccess !== 'none') {
      if (!paywallPrefill || autoUnlockKinds.length === 0) {
        setFormError('This creation does not have enough saved setup data to package automatically yet.');
        return;
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
            `Paid unlocks start at ${POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS} tokens and go up in ${POST_RESOURCE_PRICE_INCREMENT_USD_CENTS}-token steps.`,
          );
          return;
        }
        priceUsdCents = parsedPriceTokens;
      }

      resourceBundle = buildAutoResourceBundle({
        prefill: paywallPrefill,
        accessMode: recipeAccess,
        priceUsdCents,
      });
    }

    setPublishingVisibility(nextVisibility);
    setFormError(null);

    try {
      const requestBody: {
        generationId: string;
        visibility: Extract<PostVisibility, 'public' | 'private'>;
        title?: string;
        description?: string;
        shareInputMediaForRemix: boolean;
        includeGenerationReferences?: boolean;
        resourceBundle?: PostResourceBundleInput;
      } = {
        generationId,
        visibility: nextVisibility,
        title: normalizeOptionalText(publishTitle),
        description: normalizeOptionalText(publishDescription),
        shareInputMediaForRemix: false,
      };

      if (hasGenerationReferences && resourceBundle?.accessMode !== 'none') {
        requestBody.includeGenerationReferences = true;
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
          });
        } catch (shareError) {
          // Publishing is already complete. A canceled or unavailable share
          // action must never be reported as a failed publish.
          console.error('Published generation, but sharing was unavailable:', shareError);
        }
      }

      onClose();
    } catch (error) {
      console.error('Failed to publish generation:', error);
      setFormError(error instanceof Error ? error.message : 'Failed to publish');
    } finally {
      setPublishingVisibility(null);
    }
  };

  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget && !isPublishing) {
          onClose();
        }
      }}
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/80 px-4 py-6 backdrop-blur-sm sm:items-center sm:py-8"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-to-showcase-title"
        aria-describedby="publish-to-showcase-description"
        tabIndex={-1}
        className="max-h-[calc(100vh-3rem)] w-full max-w-xl overflow-y-auto rounded-[30px] border border-zinc-800 bg-zinc-950 p-6 shadow-2xl"
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h3 id="publish-to-showcase-title" className="flex items-center gap-2 text-xl font-bold text-white">
              {shareAfterPublish ? <Share2 className="h-5 w-5 text-emerald-300" /> : <Globe className="h-5 w-5 text-emerald-300" />}
              Publish this creation
            </h3>
            <p id="publish-to-showcase-description" className="mt-2 text-sm leading-6 text-zinc-400">
              {mediaOnly
                ? 'Add a title and caption, then share it to Showcase or keep it private.'
                : 'Title, caption, and optional price.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isPublishing}
            className="ui-focus-ring inline-flex min-h-12 min-w-12 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Close publish dialog"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleFormSubmit} className="space-y-5">
          <div>
            <label htmlFor="publish-title-input" className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Title</label>
            <input
              ref={titleInputRef}
              id="publish-title-input"
              type="text"
              value={publishTitle}
              onChange={(event) => setPublishTitle(event.target.value)}
              placeholder="Give your creation a name"
              className="w-full rounded-2xl border border-white/10 bg-black px-4 py-3 text-white transition-colors placeholder:text-zinc-600 focus:border-emerald-400/50 focus:outline-none"
              maxLength={60}
            />
          </div>

          <div
            aria-live="polite"
            className={`flex items-start gap-3 rounded-2xl border px-4 py-3 ${
              profileLoadState === 'ready' && isProfileReadyForPublish
                ? 'border-emerald-300/20 bg-emerald-400/8'
                : 'border-amber-300/20 bg-amber-400/8'
            }`}
          >
            <UserRound className={`mt-0.5 h-4 w-4 shrink-0 ${
              profileLoadState === 'ready' && isProfileReadyForPublish ? 'text-emerald-300' : 'text-amber-200'
            }`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white">
                {profileLoadState === 'loading'
                  ? 'Checking profile…'
                  : profileLoadState === 'error'
                    ? 'Profile check unavailable'
                    : isProfileReadyForPublish
                      ? willSellRecipe ? 'Seller profile ready' : 'Ready for public publishing'
                      : willSellRecipe ? 'Seller profile needs attention' : 'Public profile needs attention'}
              </p>
              <p className="mt-1 text-xs leading-5 text-zinc-400">
                {willSellRecipe
                  ? 'Selling a recipe requires a custom handle, display name, and profile photo.'
                  : 'Public posts require a custom handle and display name.'}
              </p>
              {profileLoadState === 'ready' && !isProfileReadyForPublish ? (
                <Link
                  href={profileRepairHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ui-focus-ring mt-2 inline-flex min-h-12 items-center text-sm font-bold text-[var(--ui-primary)] hover:text-[var(--ui-primary-strong)]"
                >
                  Complete profile in a new tab
                </Link>
              ) : null}
            </div>
          </div>

          <div>
            <label htmlFor="publish-caption-input" className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Caption optional</label>
            <textarea
              id="publish-caption-input"
              value={publishDescription}
              onChange={(event) => setPublishDescription(event.target.value)}
              placeholder="Add a short caption or context for the post."
              rows={5}
              className="w-full resize-none rounded-2xl border border-white/10 bg-black px-4 py-3 text-white transition-colors placeholder:text-zinc-600 focus:border-emerald-400/50 focus:outline-none"
              maxLength={1000}
            />
          </div>

          {!mediaOnly ? <div className={`rounded-[24px] border p-4 transition-colors duration-200 ease-[var(--ui-ease-standard)] ${
            recipeAccess !== 'none'
              ? 'border-emerald-300/30 bg-emerald-500/10'
              : 'border-white/10 bg-black/35'
          }`}>
            <div className="flex items-start gap-3">
              <div className={`rounded-2xl border p-2 transition-colors duration-200 ease-[var(--ui-ease-standard)] ${
                recipeAccess === 'none'
                  ? 'border-white/10 bg-white/[0.04] text-zinc-400'
                  : 'border-emerald-300/20 bg-emerald-400/10 text-emerald-100'
              }`}>
                {recipeAccess === 'none' ? <LockKeyhole className="h-4 w-4" /> : <BookOpen className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <div>
                    <div className="text-sm font-semibold text-white">Saved system package</div>
                    {hasGenerationReferences ? (
                      <p className="mt-1 text-xs font-semibold text-emerald-100">
                        {formatReferenceCountLabel(generationReferenceCount)}
                      </p>
                    ) : null}
                    {!hasAutoUnlock ? (
                      <p className="mt-1 text-sm leading-6 text-zinc-400">
                        Publish the media now; custom resources can be added from the post later if needed.
                      </p>
                    ) : null}
                  </div>
                  {hasAutoUnlock ? (
                    <span
                      aria-live="polite"
                      className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors duration-200 ease-[var(--ui-ease-standard)] ${
                        recipeAccess === 'none'
                          ? 'border-white/10 bg-black/30 text-zinc-400'
                          : 'border-emerald-300/25 bg-emerald-400/10 text-emerald-50'
                      }`}
                    >
                      {recipeAccessBadgeLabel}
                    </span>
                  ) : null}
                </div>

                {hasAutoUnlock ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {autoUnlockKinds.map((kind) => (
                      <span
                        key={kind}
                        className="inline-flex items-center gap-1 rounded-full border border-emerald-300/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-50"
                      >
                        <Check className="h-3 w-3" />
                        {getPostResourceKindLabel(kind)}
                      </span>
                    ))}
                  </div>
                ) : null}

                {hasAutoUnlock ? (
                  <div className="mt-4 border-t border-white/8 pt-4">
                    <fieldset>
                      <legend className="mb-2 text-sm font-semibold text-white">
                        Share the prompt and setup?
                      </legend>

                      <div className="relative grid grid-cols-3 rounded-full border border-white/10 bg-black/40 p-1">
                        <span
                          aria-hidden="true"
                          style={{ transform: `translateX(${activeAccessIndex * 100}%)` }}
                          className={`pointer-events-none absolute inset-y-1 left-1 w-[calc((100%-0.5rem)/3)] rounded-full transition-[transform,background-color] duration-200 ease-[var(--ui-ease-standard)] ${
                            recipeAccess === 'none' ? 'bg-white/10' : 'bg-emerald-300'
                          }`}
                        />
                        {RECIPE_ACCESS_OPTIONS.map((option) => {
                          const isActive = option.value === recipeAccess;
                          return (
                            <label
                              key={option.value}
                              className={`relative z-10 flex cursor-pointer items-center justify-center rounded-full px-3 py-2 text-xs font-semibold transition-[color,transform] duration-150 ease-[var(--ui-ease-standard)] active:scale-[0.97] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--ui-primary)] ${
                                isActive
                                  ? recipeAccess === 'none' ? 'text-white' : 'text-emerald-950'
                                  : 'text-zinc-400 hover:text-white'
                              }`}
                            >
                              <input
                                type="radio"
                                name="publish-recipe-access"
                                value={option.value}
                                checked={isActive}
                                onChange={() => {
                                  setRecipeAccess(option.value);
                                  setFormError(null);
                                }}
                                className="sr-only"
                              />
                              {option.label}
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>

                    <p aria-live="polite" className="mt-3 text-sm leading-6 text-zinc-400">
                      {RECIPE_ACCESS_OPTIONS[activeAccessIndex].hint}
                    </p>

                    {isPaidRecipe ? (
                      <div className="ui-enter-pop mt-4 flex origin-top flex-col gap-3 rounded-[20px] border border-emerald-300/20 bg-black/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200">Price</div>
                          <p className="mt-1 text-xs text-zinc-400">
                            From {POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS} tokens, in steps of {POST_RESOURCE_PRICE_INCREMENT_USD_CENTS}.
                            {parsedPriceTokens !== null && parsedPriceTokens > 0
                              ? ` ≈ ${formatUsdCents(parsedPriceTokens)}`
                              : ''}
                          </p>
                        </div>
                        <div className="relative w-full sm:w-36">
                          <input
                            type="number"
                            inputMode="numeric"
                            min={POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS}
                            step={POST_RESOURCE_PRICE_INCREMENT_USD_CENTS}
                            value={priceTokens}
                            onChange={(event) => {
                              setPriceTokens(event.target.value);
                              setFormError(null);
                            }}
                            aria-label="Recipe price in tokens"
                            className="w-full rounded-full border border-white/10 bg-white/[0.04] py-2 pl-4 pr-16 text-center text-sm font-semibold text-white outline-none transition-colors duration-150 focus:border-emerald-300/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                          />
                          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs text-zinc-500">tokens</span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : showPaidShortcut ? (
                  <div className="mt-4 border-t border-white/8 pt-4">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                      <BadgeDollarSign className="h-3.5 w-3.5 text-emerald-300" />
                      Optional recipe
                    </div>
                    <p className="mt-2 text-sm leading-6 text-zinc-300">
                      This creation can publish without pricing. Add paid resources later from the post if the setup becomes reusable.
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          </div> : null}

          {formError ? (
            <div role="alert" aria-live="assertive" className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              <div className="flex items-start gap-2">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{formError}</span>
              </div>
              {needsProfileRepair ? (
                <Link
                  href={profileRepairHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ui-focus-ring mt-2 inline-flex min-h-12 items-center font-bold text-white underline decoration-white/40 underline-offset-4"
                >
                  Complete profile in a new tab
                </Link>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-3 border-t border-white/8 pt-5 sm:grid-cols-2">
            <button
              type="button"
              disabled={isPublishing}
              onClick={() => void handleQuickPublish('private')}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-zinc-100 transition-[background-color,border-color,transform] duration-150 ease-[var(--ui-ease-standard)] hover:border-white/20 hover:bg-white/[0.08] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {publishingVisibility === 'private' ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}
              Private post
            </button>
            <button
              type="submit"
              disabled={isPublishing}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-white px-4 py-3 text-sm font-semibold text-black transition-[background-color,transform] duration-150 ease-[var(--ui-ease-standard)] hover:bg-zinc-200 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {publishingVisibility === 'public' ? <Loader2 className="h-4 w-4 animate-spin" /> : isPaidRecipe ? <BadgeDollarSign className="h-4 w-4" /> : <Globe className="h-4 w-4" />}
              Public post
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
