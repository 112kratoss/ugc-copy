'use client';

import { useEffect, useEffectEvent, useId, useRef } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

import CreatorProfileCard from '@/app/creations/CreatorProfileCard';
import type { EditableCreatorProfile } from '@/lib/profile';

const EDITOR_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface CreatorProfileEditSheetProps {
  open: boolean;
  /** The owner's own copy of the profile, once its read has landed. */
  profile: EditableCreatorProfile | null;
  loadError: string | null;
  onRetry: () => void;
  /** Close, or Escape: the caller asks before throwing edits away. */
  onRequestClose: () => void;
  /** Any field the editor changes reports here. */
  onEdited: () => void;
  onSaved: (profile: EditableCreatorProfile) => void;
}

/**
 * The owner's Edit profile dialog on their creator page: the profile editor, with framer-motion
 * and everything else only it uses. It is code no visitor needs (about 400 KB of script with the
 * Supabase client the editor uploads with), so `ProfileActions` loads it with import(): ahead of
 * the press for the owner (`creator-profile-edit-sheet-loader.ts`), and never for anyone else.
 *
 * It stays mounted once loaded, so the dialog animates out as it closes.
 */
export function CreatorProfileEditSheet({
  open,
  profile,
  loadError,
  onRetry,
  onRequestClose,
  onEdited,
  onSaved,
}: CreatorProfileEditSheetProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  const keepFocusInEditor = (event: KeyboardEvent) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(EDITOR_FOCUSABLE_SELECTOR));
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const isOutside = active === dialog || !dialog.contains(active);
    if (event.shiftKey && (active === first || isOutside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || isOutside)) {
      event.preventDefault();
      first.focus();
    }
  };

  const onEditorKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onRequestClose();
      return;
    }
    if (event.key === 'Tab') {
      keepFocusInEditor(event);
    }
  });

  // From the render that draws the dialog: on a first press made before this code had arrived,
  // that is the render after it lands, not the press's.
  useEffect(() => {
    if (!open) {
      return;
    }

    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => onEditorKeyDown(event);
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm sm:p-6"
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="relative flex h-full max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-zinc-950 shadow-2xl outline-none"
          >
            {/* Fixed Header */}
            <div className="flex shrink-0 items-center justify-between border-b border-white/5 bg-zinc-900/50 px-6 py-4">
              <h2 id={titleId} className="text-xl font-semibold text-white">Edit profile</h2>
              <button
                type="button"
                onClick={onRequestClose}
                aria-label="Close"
                className="ui-focus-ring -my-1.5 inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/5 text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>

            {/* Scrollable Content. Any field the editor changes reports here. */}
            <div
              className="flex-1 overflow-y-auto p-4 sm:p-6 custom-scrollbar"
              onChange={onEdited}
            >
              {profile ? (
                <CreatorProfileCard
                  initialProfile={profile}
                  loadError={null}
                  isEmbedded={true}
                  onProfileSaved={onSaved}
                />
              ) : loadError ? (
                <div role="alert" className="rounded-3xl border border-rose-300/20 bg-rose-500/5 p-6 text-sm text-rose-100">
                  <p className="font-bold">{loadError}</p>
                  <button
                    type="button"
                    onClick={onRetry}
                    className="ui-focus-ring mt-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-rose-300/25 bg-rose-400/10 px-4 font-bold"
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden />
                    Try again
                  </button>
                </div>
              ) : (
                <div role="status" aria-label="Loading your profile" className="rounded-3xl border border-white/5 p-6">
                  <div className="h-6 w-48 animate-pulse rounded-full bg-white/10" />
                  <div className="mt-3 h-4 w-80 max-w-full animate-pulse rounded-full bg-white/5" />
                  <div className="mt-6 grid gap-4 md:grid-cols-2">
                    <div className="h-12 animate-pulse rounded-2xl bg-black/40" />
                    <div className="h-12 animate-pulse rounded-2xl bg-black/40" />
                    <div className="h-24 animate-pulse rounded-2xl bg-black/40 md:col-span-2" />
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
