'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { BadgeDollarSign, Check, CircleAlert, Globe, Loader2, LockKeyhole, Share2, UserRound, X } from 'lucide-react';

import { sharePublicGeneration } from '@/lib/share-client';
import type { GenerationShareSourceSurface } from '@/lib/share';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import { getCreatorProfileReadiness, type ProfileApiResponse } from '@/lib/profile';
import {
  getPostResourceKindLabel,
  type PostResourceBundleInput,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';

type PostVisibility = 'public' | 'unlisted' | 'private';
type ProfileLoadState = 'idle' | 'loading' | 'ready' | 'error';

const RESOURCE_KIND_ORDER: PostResourceKind[] = ['prompt', 'workflow', 'files', 'notes', 'remix'];

function normalizeOptionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getDefaultPublishDescription(
  defaultDescription: string,
  paywallPrefill: GenerationPaywallPrefill | null | undefined
): string {
  return defaultDescription.trim() || paywallPrefill?.notesMarkdown?.trim() || '';
}

function parsePriceUsdToCents(value: string): number | null {
  const normalized = Number.parseFloat(value.trim());
  if (!Number.isFinite(normalized)) {
    return null;
  }

  return Math.round(normalized * 100);
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
  priceUsdCents,
}: {
  prefill: GenerationPaywallPrefill;
  priceUsdCents: number;
}): PostResourceBundleInput {
  const kinds = getAutoUnlockKinds(prefill);

  return {
    accessMode: 'paid',
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
  initialSellAutoUnlock?: boolean;
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
  initialSellAutoUnlock = false,
  paywallPrefill = null,
  shareAfterPublish,
  onPublished,
}: PublishToShowcaseModalProps) {
  const [publishTitle, setPublishTitle] = useState(defaultTitle);
  const [publishDescription, setPublishDescription] = useState(() =>
    getDefaultPublishDescription(defaultDescription, paywallPrefill)
  );
  const [sellAutoUnlock, setSellAutoUnlock] = useState(false);
  const [priceUsd, setPriceUsd] = useState('9');
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
  const willPublishUnlock = sellAutoUnlock;
  const parsedPriceUsdCents = parsePriceUsdToCents(priceUsd);
  const isPublishing = publishingVisibility !== null;
  const profileReadiness = getCreatorProfileReadiness(profile);
  const isProfileReadyForPublish = willPublishUnlock
    ? profileReadiness.sellerReady
    : profileReadiness.publicPublishReady;

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
    setPublishDescription(getDefaultPublishDescription(defaultDescription, paywallPrefill));
    setSellAutoUnlock(Boolean(initialSellAutoUnlock && hasAutoUnlock));
    setPriceUsd('9');
    setPublishingVisibility(null);
    setFormError(null);
    setNeedsProfileRepair(false);
  }, [defaultDescription, defaultTitle, generationId, hasAutoUnlock, initialSellAutoUnlock, isOpen, paywallPrefill]);

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
        willPublishUnlock
          ? 'Complete your profile before publishing a recipe: choose a custom handle, add your display name, and upload a profile photo.'
          : 'Complete your profile before publishing publicly: choose a custom handle and add your display name.'
      );
      return;
    }

    let resourceBundle: PostResourceBundleInput | null = mediaOnly ? null : { accessMode: 'none' };
    if (sellAutoUnlock) {
      if (!paywallPrefill || autoUnlockKinds.length === 0) {
        setFormError('This creation does not have enough saved setup data to package automatically yet.');
        return;
      }

      if (parsedPriceUsdCents === null || parsedPriceUsdCents < 100) {
        setFormError('Paid recipes must be priced at $1.00 or above.');
        return;
      }

      resourceBundle = buildAutoResourceBundle({
        prefill: paywallPrefill,
        priceUsdCents: parsedPriceUsdCents,
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
                : 'Title, notes, and optional price.'}
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
                      ? willPublishUnlock ? 'Seller profile ready' : 'Ready for public publishing'
                      : willPublishUnlock ? 'Seller profile needs attention' : 'Public profile needs attention'}
              </p>
              <p className="mt-1 text-xs leading-5 text-zinc-400">
                {willPublishUnlock
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
            <label htmlFor="publish-notes-input" className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Notes optional</label>
            <textarea
              id="publish-notes-input"
              value={publishDescription}
              onChange={(event) => setPublishDescription(event.target.value)}
              placeholder="Add a short caption or context for the post."
              rows={5}
              className="w-full resize-none rounded-2xl border border-white/10 bg-black px-4 py-3 text-white transition-colors placeholder:text-zinc-600 focus:border-emerald-400/50 focus:outline-none"
              maxLength={1000}
            />
          </div>

          {!mediaOnly ? <div className={`rounded-[24px] border p-4 transition ${
            sellAutoUnlock
              ? 'border-emerald-300/30 bg-emerald-500/10'
              : 'border-white/10 bg-black/35'
          }`}>
            <div className="flex items-start gap-3">
              <div className="rounded-2xl border border-emerald-300/20 bg-emerald-400/10 p-2 text-emerald-100">
                <LockKeyhole className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-3">
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
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={sellAutoUnlock}
                        onChange={(event) => {
                          setSellAutoUnlock(event.target.checked);
                          setFormError(null);
                        }}
                        className="mt-1 h-4 w-4 rounded border-white/20 bg-black text-emerald-400 focus:ring-emerald-400"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center justify-between gap-3">
                          <span className="text-sm font-semibold text-white">Sell the prompt and setup</span>
                          <span className="rounded-full border border-emerald-300/20 bg-black/25 px-2.5 py-1 text-xs font-semibold text-emerald-50">
                            Optional
                          </span>
                        </span>
                        <span className="mt-1 block text-sm leading-6 text-zinc-400">
                          Turn on pricing when this reusable setup is valuable enough to sell as a recipe.
                        </span>
                      </span>
                    </label>

                    {sellAutoUnlock ? (
                      <div className="mt-4 flex flex-col gap-3 rounded-[20px] border border-emerald-300/20 bg-black/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200">Price</div>
                          <p className="mt-1 text-xs text-zinc-400">Minimum $1.00.</p>
                        </div>
                        <div className="relative w-full sm:w-28">
                          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-zinc-500">$</span>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={priceUsd}
                            onChange={(event) => {
                              setPriceUsd(event.target.value);
                              setFormError(null);
                            }}
                            aria-label="Recipe price"
                            className="w-full rounded-full border border-white/10 bg-white/[0.04] py-2 pl-8 pr-3 text-center text-sm font-semibold text-white outline-none transition focus:border-emerald-300/50"
                          />
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
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {publishingVisibility === 'private' ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}
              Private post
            </button>
            <button
              type="submit"
              disabled={isPublishing}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-white px-4 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {publishingVisibility === 'public' ? <Loader2 className="h-4 w-4 animate-spin" /> : sellAutoUnlock ? <BadgeDollarSign className="h-4 w-4" /> : <Globe className="h-4 w-4" />}
              Public post
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
