'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Globe, Loader2, Share2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

import { sharePublicGeneration } from '@/lib/share-client';
import type { GenerationShareSourceSurface } from '@/lib/share';
import { supabase } from '@/lib/supabase';

interface PublishToShowcaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  generationId: string | null;
  defaultTitle?: string;
  defaultDescription?: string;
  showPaidShortcut?: boolean;
  shareAfterPublish?: {
    title: string;
    description?: string | null;
    sourceSurface: GenerationShareSourceSurface;
  };
  onPublished?: (payload: { title: string; description: string }) => void;
}

export default function PublishToShowcaseModal({
  isOpen,
  onClose,
  generationId,
  defaultTitle = '',
  defaultDescription = '',
  showPaidShortcut = true,
  shareAfterPublish,
  onPublished,
}: PublishToShowcaseModalProps) {
  const router = useRouter();
  const [publishTitle, setPublishTitle] = useState(defaultTitle);
  const [publishDescription, setPublishDescription] = useState(defaultDescription);
  const [isPublishing, setIsPublishing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setPublishTitle(defaultTitle);
    setPublishDescription(defaultDescription);
    setFormError(null);
  }, [defaultDescription, defaultTitle, generationId, isOpen]);

  if (!isOpen || !generationId) {
    return null;
  }

  const buttonLabel = shareAfterPublish ? 'Publish & share' : 'Publish public post now';

  const handleQuickPublish = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isPublishing) {
      return;
    }

    setIsPublishing(true);
    setFormError(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const response = await fetch('/api/showcase/publish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token
            ? {
                Authorization: `Bearer ${session.access_token}`,
              }
            : {}),
        },
        body: JSON.stringify({
          generationId,
          isPublic: true,
          title: publishTitle.trim() || undefined,
          description: publishDescription.trim() || undefined,
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to publish');
      }

      const normalizedTitle = publishTitle.trim();
      const normalizedDescription = publishDescription.trim();

      onPublished?.({
        title: normalizedTitle,
        description: normalizedDescription,
      });

      if (shareAfterPublish) {
        await sharePublicGeneration({
          generationId,
          title: normalizedTitle || shareAfterPublish.title,
          description: normalizedDescription || shareAfterPublish.description || null,
          sourceSurface: shareAfterPublish.sourceSurface,
          accessToken: session?.access_token ?? null,
        });
      }

      onClose();
    } catch (error) {
      console.error('Failed to publish generation:', error);
      setFormError(error instanceof Error ? error.message : 'Failed to publish');
    } finally {
      setIsPublishing(false);
    }
  };

  const handleRouteToComposer = () => {
    onClose();
    router.push(
      `/post/new?generationId=${encodeURIComponent(generationId)}&publishIntent=paid-generation&resourceMode=paid&focus=price`
    );
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      >
        <motion.div
          initial={{ scale: 0.95, y: 20 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.95, y: 20 }}
          onClick={(event) => event.stopPropagation()}
          className="w-full max-w-lg rounded-[30px] border border-zinc-800 bg-zinc-900 p-6 shadow-2xl"
        >
          <div className="mb-6 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-xl font-bold text-white">
              {shareAfterPublish ? <Share2 className="h-5 w-5 text-emerald-300" /> : <Globe className="h-5 w-5 text-emerald-300" />}
              {shareAfterPublish ? 'Publish & share' : 'Publish this creation'}
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="text-zinc-500 transition-colors hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <p className="text-sm leading-7 text-zinc-400">
            {showPaidShortcut
              ? 'Keep this step lightweight. Publish the proof right away, or jump into the composer with the saved prompt attached and the price field ready if you want to sell this creation.'
              : 'Keep this step lightweight. Publish the proof now and fine-tune anything else later from your workspace.'}
          </p>

          <form onSubmit={handleQuickPublish} className="mt-6 space-y-4">
            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-400">Title (Optional)</label>
              <input
                type="text"
                value={publishTitle}
                onChange={(event) => setPublishTitle(event.target.value)}
                placeholder="Give your creation a name"
                className="w-full rounded-2xl border border-white/10 bg-black px-4 py-3 text-white transition-colors focus:border-emerald-500 focus:outline-none"
                maxLength={60}
              />
            </div>

            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-400">Description (Optional)</label>
              <textarea
                value={publishDescription}
                onChange={(event) => setPublishDescription(event.target.value)}
                placeholder="Add a short line about what people are looking at."
                rows={3}
                className="w-full resize-none rounded-2xl border border-white/10 bg-black px-4 py-3 text-white transition-colors focus:border-emerald-500 focus:outline-none"
                maxLength={200}
              />
            </div>

            {showPaidShortcut ? (
              <div className="rounded-[24px] border border-white/10 bg-black/35 p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Price the saved unlock</div>
                <p className="mt-2 text-sm leading-6 text-zinc-300">
                  Open the composer with this generation already attached, paid mode selected, and the price field focused. You can still edit the unlock or switch it to free once you land there.
                </p>
                <button
                  type="button"
                  onClick={handleRouteToComposer}
                  className="mt-4 inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition hover:border-emerald-300/40 hover:bg-emerald-500/15"
                >
                  Set price and continue
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            ) : null}

            {formError ? (
              <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                {formError}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={isPublishing}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-white px-4 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isPublishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
              {buttonLabel}
            </button>
          </form>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
