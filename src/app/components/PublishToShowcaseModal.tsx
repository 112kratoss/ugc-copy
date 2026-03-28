'use client';

import { useEffect, useState } from 'react';
import { Globe, Loader2, Share2, X } from 'lucide-react';
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
  shareAfterPublish,
  onPublished,
}: PublishToShowcaseModalProps) {
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

  const buttonLabel = shareAfterPublish ? 'Publish & share' : 'Publish now';

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
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
          className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl"
        >
          <div className="mb-6 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-xl font-bold">
              {shareAfterPublish ? <Share2 className="h-5 w-5 text-purple-400" /> : <Globe className="h-5 w-5 text-purple-400" />}
              {shareAfterPublish ? 'Publish & share' : 'Publish to showcase'}
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="text-zinc-500 transition-colors hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <p className="mb-6 text-sm text-zinc-400">
            Publish this creation so it gets a public UGC copy page you can share as a link.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-400">Title (Optional)</label>
              <input
                type="text"
                value={publishTitle}
                onChange={(event) => setPublishTitle(event.target.value)}
                placeholder="Give your creation a name"
                className="w-full rounded-xl border border-white/10 bg-black px-4 py-3 text-white transition-colors focus:border-purple-500 focus:outline-none"
                maxLength={60}
              />
            </div>

            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-400">Description (Optional)</label>
              <textarea
                value={publishDescription}
                onChange={(event) => setPublishDescription(event.target.value)}
                placeholder="Share the story behind this creation."
                rows={3}
                className="w-full resize-none rounded-xl border border-white/10 bg-black px-4 py-3 text-white transition-colors focus:border-purple-500 focus:outline-none"
                maxLength={200}
              />
            </div>

            {formError ? (
              <p className="text-sm text-rose-300">{formError}</p>
            ) : null}

            <div className="flex gap-3 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-xl bg-zinc-800 py-3 font-medium text-white transition-colors hover:bg-zinc-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPublishing}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 py-3 font-medium text-white transition-all hover:from-purple-500 hover:to-pink-500 disabled:opacity-50"
              >
                {isPublishing ? <Loader2 className="h-5 w-5 animate-spin" /> : shareAfterPublish ? <Share2 className="h-4 w-4" /> : <Globe className="h-4 w-4" />}
                {isPublishing ? 'Publishing...' : buttonLabel}
              </button>
            </div>
          </form>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
