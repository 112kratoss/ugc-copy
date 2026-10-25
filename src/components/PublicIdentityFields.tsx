'use client';

import { UserRound } from 'lucide-react';

import { normalizeHandleInput, type PublicIdentityDraft, type PublicIdentityErrors } from '@/lib/public-identity';

interface PublicIdentityFieldsProps {
  idPrefix: string;
  value: PublicIdentityDraft;
  errors: PublicIdentityErrors;
  disabled?: boolean;
  onChange: (next: PublicIdentityDraft) => void;
}

/**
 * The name and handle a public post shows, asked for beside the publish
 * buttons of a creator who has neither yet. Publishing publicly saves them to
 * the profile first (`savePublicIdentity`), so the post is never refused for
 * them after the work is done.
 */
export default function PublicIdentityFields({ idPrefix, value, errors, disabled = false, onChange }: PublicIdentityFieldsProps) {
  const nameId = `${idPrefix}-display-name`;
  const handleId = `${idPrefix}-handle`;

  return (
    <div className="rounded-2xl border border-amber-300/20 bg-amber-400/8 px-4 py-3">
      <div className="flex items-start gap-3">
        <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">Your name and handle</p>
          <p className="mt-1 text-xs leading-5 text-zinc-400">
            Public posts show both. They are saved to your profile when you publish, and you can change them there later.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={nameId} className="mb-1.5 block text-xs font-semibold text-zinc-300">Display name</label>
              <input
                id={nameId}
                type="text"
                value={value.displayName}
                disabled={disabled}
                autoComplete="name"
                maxLength={60}
                aria-invalid={errors.displayName ? true : undefined}
                aria-describedby={errors.displayName ? `${nameId}-error` : undefined}
                onChange={(event) => onChange({ ...value, displayName: event.target.value })}
                placeholder="Your name"
                className="w-full rounded-xl border border-white/10 bg-black px-3 py-2.5 text-sm text-white transition-colors placeholder:text-zinc-600 focus:border-amber-300/50 focus:outline-none disabled:opacity-60"
              />
              {errors.displayName ? (
                <p id={`${nameId}-error`} className="mt-1.5 text-xs leading-5 text-rose-300">{errors.displayName}</p>
              ) : null}
            </div>
            <div>
              <label htmlFor={handleId} className="mb-1.5 block text-xs font-semibold text-zinc-300">Handle</label>
              <div className="flex items-center rounded-xl border border-white/10 bg-black transition-colors focus-within:border-amber-300/50">
                <span className="pl-3 text-sm text-zinc-500" aria-hidden="true">@</span>
                <input
                  id={handleId}
                  type="text"
                  value={value.username}
                  disabled={disabled}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={24}
                  aria-invalid={errors.username ? true : undefined}
                  aria-describedby={errors.username ? `${handleId}-error` : `${handleId}-hint`}
                  onChange={(event) => onChange({ ...value, username: normalizeHandleInput(event.target.value) })}
                  placeholder="your-handle"
                  className="min-w-0 flex-1 bg-transparent px-1.5 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none disabled:opacity-60"
                />
              </div>
              {errors.username ? (
                <p id={`${handleId}-error`} className="mt-1.5 text-xs leading-5 text-rose-300">{errors.username}</p>
              ) : (
                <p id={`${handleId}-hint`} className="mt-1.5 text-xs leading-5 text-zinc-500">3–24 lowercase letters, numbers or hyphens.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
