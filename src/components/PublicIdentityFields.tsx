'use client';

import { UserRound } from 'lucide-react';

import { Surface, Text } from '@/components/DesignSystem';
import {
  normalizeHandleInput,
  PUBLIC_HANDLE_RULE,
  type PublicIdentityDraft,
  type PublicIdentityErrors,
} from '@/lib/public-identity';

interface PublicIdentityFieldsProps {
  idPrefix: string;
  value: PublicIdentityDraft;
  errors: PublicIdentityErrors;
  disabled?: boolean;
  onChange: (next: PublicIdentityDraft) => void;
}

const FIELD_FRAME = 'rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] transition-colors focus-within:border-[var(--ui-accent-commerce)]';
const FIELD_INPUT = 'w-full min-w-0 bg-transparent py-2.5 text-sm text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)] focus:outline-none disabled:opacity-60';

/**
 * The name and handle a public post shows, asked for beside the publish
 * buttons of a creator who has neither yet. Publishing publicly saves them to
 * the profile first (`claimPublicIdentity`), so the post is never refused for
 * them after the work is done.
 */
export default function PublicIdentityFields({ idPrefix, value, errors, disabled = false, onChange }: PublicIdentityFieldsProps) {
  const nameId = `${idPrefix}-display-name`;
  const handleId = `${idPrefix}-handle`;

  return (
    <Surface variant="soft" padding="md" className="flex gap-3">
      <UserRound className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ui-accent-commerce)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <Text as="h3" variant="label" className="text-[var(--ui-text-primary)]">Your name and handle</Text>
        <Text variant="bodySm" className="mt-1">
          Public posts show both. They are saved to your profile when you publish, and you can change them there later.
        </Text>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={nameId} className="mb-1.5 block">
              <Text as="span" variant="label">Display name</Text>
            </label>
            <div className={FIELD_FRAME}>
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
                className={`${FIELD_INPUT} px-3`}
              />
            </div>
            {errors.displayName ? (
              <div id={`${nameId}-error`} className="mt-1.5">
                <Text variant="caption" className="text-[var(--ui-accent-danger)]">{errors.displayName}</Text>
              </div>
            ) : null}
          </div>
          <div>
            <label htmlFor={handleId} className="mb-1.5 block">
              <Text as="span" variant="label">Handle</Text>
            </label>
            <div className={`${FIELD_FRAME} flex items-center`}>
              <span className="pl-3 text-sm text-[var(--ui-text-faint)]" aria-hidden="true">@</span>
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
                className={`${FIELD_INPUT} px-1.5`}
              />
            </div>
            <div id={errors.username ? `${handleId}-error` : `${handleId}-hint`} className="mt-1.5">
              <Text variant="caption" className={errors.username ? 'text-[var(--ui-accent-danger)]' : undefined}>
                {errors.username ?? PUBLIC_HANDLE_RULE}
              </Text>
            </div>
          </div>
        </div>
      </div>
    </Surface>
  );
}
