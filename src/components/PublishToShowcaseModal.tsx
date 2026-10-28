'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { ArrowRight, BadgeDollarSign, BookOpen, Check, CircleAlert, Globe, Loader2, LockKeyhole, Share2, UserRound, X } from 'lucide-react';

import PublicIdentityFields from '@/components/PublicIdentityFields';
import { usePublishCreation, type PublishedCreation } from '@/components/usePublishCreation';
import type { GenerationShareSourceSurface } from '@/lib/share';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import { TITLE_MAX_LENGTH } from '@/lib/post-limits';
import type { CreationTitleSource } from '@/lib/creation-post-title';
import {
  formatPostResourceCreditAmount,
  getPostResourceKindLabel,
  POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS,
  POST_RESOURCE_PRICE_INCREMENT_USD_CENTS,
  type PostResourceBundleAccessMode,
} from '@/lib/post-resource-bundles';
import { formatRecipeMoneyLine } from '@/lib/recipe-money-line';

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
    label: 'No recipe',
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
    hint: 'Buyers see the price before paying. Until then only the recipe preview and item types are public.',
  },
];

function formatReferenceCountLabel(count: number): string {
  return count === 1 ? '1 reference included' : `${count} references included`;
}

interface PublishToShowcaseModalProps {
  isOpen: boolean;
  onClose: () => void;
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
  shareAfterPublish?: {
    title: string;
    description?: string | null;
    sourceSurface: GenerationShareSourceSurface;
  };
  onPublished?: (payload: PublishedCreation) => void;
}

export default function PublishToShowcaseModal({
  isOpen,
  onClose,
  generationId,
  accessToken = null,
  defaultTitle = '',
  creation = null,
  defaultDescription = '',
  showPaidShortcut = true,
  mediaOnly = false,
  paywallPrefill = null,
  shareAfterPublish,
  onPublished,
}: PublishToShowcaseModalProps) {
  const draft = usePublishCreation({
    active: isOpen,
    generationId,
    accessToken,
    defaultTitle,
    creation,
    defaultDescription,
    showPaidShortcut,
    mediaOnly,
    paywallPrefill,
    shareAfterPublish,
    onPublished,
    onFinished: onClose,
  });
  const {
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
  } = draft;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const isPaidRecipe = recipeAccess === 'paid';
  const activeAccessIndex = Math.max(
    0,
    RECIPE_ACCESS_OPTIONS.findIndex((option) => option.value === recipeAccess)
  );
  const recipeAccessBadgeLabel = recipeAccess === 'none'
    ? 'No recipe'
    : recipeAccess === 'free'
      ? 'Free recipe'
      : parsedPriceTokens !== null && parsedPriceTokens >= POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS
        ? `Paid recipe · ${formatPostResourceCreditAmount(parsedPriceTokens)}`
        : 'Paid recipe';

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

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
  }, [generationId, isOpen, isPublishingRef]);

  if (!isOpen || !generationId) {
    return null;
  }

  const handleFormSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void publish('public');
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
                ? 'Add a title and caption, then share it to Explore or keep it private.'
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

        {/* noValidate, as the composer's form: the browser's own bubble (a
            price of 95 against step=10) blocked the submit before the window
            could say its price rule. */}
        <form onSubmit={handleFormSubmit} noValidate className="space-y-5">
          <div>
            <label className="flex min-h-11 items-center gap-3 text-sm text-zinc-200"><input type="checkbox" checked={isNsfw} onChange={(event) => setIsNsfw(event.target.checked)} />Mark as NSFW / mature</label>
            <label htmlFor="publish-title-input" className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Title</label>
            <input
              ref={titleInputRef}
              id="publish-title-input"
              type="text"
              value={publishTitle}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Give your creation a name"
              className="w-full rounded-2xl border border-white/10 bg-black px-4 py-3 text-white transition-colors placeholder:text-zinc-600 focus:border-emerald-400/50 focus:outline-none"
              maxLength={TITLE_MAX_LENGTH}
            />
            {titleSuggestionHint ? (
              <p className="mt-2 text-xs leading-5 text-zinc-500">{titleSuggestionHint}</p>
            ) : null}
          </div>

          {needsPublicIdentity ? (
            <PublicIdentityFields
              idPrefix="publish-identity"
              value={identity}
              errors={identityErrors}
              disabled={isPublishing}
              accessToken={accessToken}
              savedUsername={profile?.username}
              onChange={setIdentity}
            />
          ) : (
            <div
              aria-live="polite"
              className={`flex items-start gap-3 rounded-2xl border px-4 py-3 ${
                profileLoadState === 'ready'
                  ? 'border-emerald-300/20 bg-emerald-400/8'
                  : 'border-white/10 bg-white/[0.03]'
              }`}
            >
              <UserRound className={`mt-0.5 h-4 w-4 shrink-0 ${
                profileLoadState === 'ready' ? 'text-emerald-300' : 'text-zinc-400'
              }`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white">
                  {profileLoadState === 'loading' || profileLoadState === 'idle'
                    ? 'Checking profile…'
                    : profileLoadState === 'error'
                      ? 'Profile check unavailable'
                      : 'Ready for public publishing'}
                </p>
                <p className="mt-1 text-xs leading-5 text-zinc-400">
                  {profileLoadState === 'ready' && profile?.username
                    ? `Posting as ${profile.displayName?.trim() || profile.username} · @${profile.username}`
                    : 'Public posts show your name and handle.'}
                </p>
              </div>
            </div>
          )}

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
                    <div className="text-sm font-semibold text-white">Recipe</div>
                    {hasGenerationReferences ? (
                      <p className="mt-1 text-xs font-semibold text-emerald-100">
                        {formatReferenceCountLabel(generationReferenceCount)}
                      </p>
                    ) : null}
                    {!hasAutoUnlock ? (
                      <p className="mt-1 text-sm leading-6 text-zinc-400">
                        Publish the media now; you can add a recipe from the post later.
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
                                onChange={() => setRecipeAccess(option.value)}
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
                      <div className="ui-enter-pop mt-4 origin-top rounded-[20px] border border-emerald-300/20 bg-black/30 p-3">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200">Price</div>
                            <p className="mt-1 text-xs text-zinc-400">
                              {`From ${POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS} credits, in steps of ${POST_RESOURCE_PRICE_INCREMENT_USD_CENTS}.`}
                            </p>
                          </div>
                          <div className="relative w-full sm:w-36">
                            <input
                              type="number"
                              inputMode="numeric"
                              min={POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS}
                              step={POST_RESOURCE_PRICE_INCREMENT_USD_CENTS}
                              value={priceTokens}
                              onChange={(event) => setPriceTokens(event.target.value)}
                              aria-label="Recipe price in credits"
                              aria-describedby="publish-recipe-money-line"
                              className="w-full rounded-full border border-white/10 bg-white/[0.04] py-2 pl-4 pr-16 text-center text-sm font-semibold text-white outline-none transition-colors duration-150 focus:border-emerald-300/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                            <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs text-zinc-500">credits</span>
                          </div>
                        </div>
                        {/* The composer's line under every price (A-F5). */}
                        <p id="publish-recipe-money-line" className="mt-3 text-xs font-medium leading-5 text-emerald-200">
                          {formatRecipeMoneyLine(parsedPriceTokens ?? 0)}
                        </p>
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
                      This creation can publish without a price. Add a recipe from the post later if the setup becomes reusable.
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
            </div>
          ) : null}

          <div className="grid gap-3 border-t border-white/8 pt-5 sm:grid-cols-2">
            <button
              type="button"
              disabled={isPublishing}
              onClick={() => void publish('private')}
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

          {/* The full composer for the same creation (decision 18, 2026-10-17):
              media, Made with, hand-built recipe cards. It reads the creation
              from its address, and no title or caption, so it starts from the
              creation's own. */}
          <div className="flex justify-center">
            <Link
              href={`/post/new?${new URLSearchParams({ generationId }).toString()}`}
              aria-disabled={isPublishing || undefined}
              onClick={(event) => {
                // Leaving while a publish is in flight would post the creation twice.
                if (isPublishing) event.preventDefault();
              }}
              className={`ui-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-zinc-400 transition ${
                isPublishing ? 'pointer-events-none opacity-50' : 'hover:text-white'
              }`}
            >
              More options
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
