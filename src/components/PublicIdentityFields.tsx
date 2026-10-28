'use client';

import { UserRound } from 'lucide-react';

import { Surface, Text } from '@/components/DesignSystem';
import { useHandleAvailability } from '@/components/useHandleAvailability';
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
  /** With a token, the handle is checked with the server as it is typed. */
  accessToken?: string | null;
  /** The profile's stored handle: the account's own claimed handle is never checked. */
  savedUsername?: string | null;
  /**
   * The card with its heading and a line on why both are asked for. A dialog
   * that says that in its own title draws the two fields alone.
   */
  framed?: boolean;
  /** One field under the other at every width, for a column too narrow for two (the creators'). */
  stacked?: boolean;
}

const FIELD_FRAME = 'rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] transition-colors focus-within:border-[var(--ui-accent-commerce)]';
const FIELD_INPUT = 'w-full min-w-0 bg-transparent py-2.5 text-sm text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)] focus:outline-none disabled:opacity-60';

/**
 * The name and handle a public post shows, asked for beside the publish
 * buttons of a creator who has neither yet, and in the question a list asks
 * when such a creator makes a post public. Publishing publicly saves them to
 * the profile first (`claimPublicIdentity`), so the post is never refused for
 * them after the work is done.
 */
export default function PublicIdentityFields({
  idPrefix,
  value,
  errors,
  disabled = false,
  onChange,
  accessToken,
  savedUsername,
  framed = true,
  stacked = false,
}: PublicIdentityFieldsProps) {
  const nameId = `${idPrefix}-display-name`;
  const handleId = `${idPrefix}-handle`;
  const availability = useHandleAvailability(value, { accessToken, savedUsername });
  // A verdict from the form or the save comes first; then the server's word as
  // it is typed; else the rule, so the line under the field always says something.
  const handleError = errors.username ?? (availability.state === 'taken' ? availability.message : undefined);
  const handleHint = handleError
    ?? (availability.state === 'checking'
      ? 'Checking availability…'
      : availability.state === 'available'
        ? 'This handle is available.'
        : PUBLIC_HANDLE_RULE);
  // One colour class, never two: `Text` joins without merging, so a second
  // colour would be settled by the order of the stylesheet, not of the classes
  // (Tailwind emits the faint colour after the danger one, so the faint won).
  const handleHintTone = handleError
    ? 'text-[var(--ui-accent-danger)]'
    : availability.state === 'available'
      ? 'text-emerald-300'
      : 'text-[var(--ui-text-faint)]';

  const fields = (
    <div className={`${framed ? 'mt-3 ' : ''}grid gap-3${stacked ? '' : ' sm:grid-cols-2'}`}>
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
          // The caption's size and weight with the danger colour alone, as the handle's line has.
          <p id={`${nameId}-error`} className="mt-1.5 text-xs font-semibold leading-[17px] text-[var(--ui-accent-danger)]">
            {errors.displayName}
          </p>
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
            aria-invalid={handleError ? true : undefined}
            aria-describedby={`${handleId}-hint`}
            onChange={(event) => onChange({ ...value, username: normalizeHandleInput(event.target.value) })}
            placeholder="your-handle"
            className={`${FIELD_INPUT} px-1.5`}
          />
        </div>
        {/* Polite: the check answers a pause in typing, not a press. */}
        <p id={`${handleId}-hint`} aria-live="polite" className={`mt-1.5 text-xs font-semibold leading-[17px] ${handleHintTone}`}>
          {handleHint}
        </p>
      </div>
    </div>
  );

  if (!framed) {
    return fields;
  }

  return (
    <Surface variant="soft" padding="md" className="flex gap-3">
      <UserRound className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ui-accent-commerce)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <Text as="h3" variant="label" className="text-[var(--ui-text-primary)]">Your name and handle</Text>
        <Text variant="bodySm" className="mt-1">
          Public posts show both. They are saved to your profile when you publish, and you can change them there later.
        </Text>
        {fields}
      </div>
    </Surface>
  );
}
