'use client';

import clsx from 'clsx';
import { useId } from 'react';
import { Check, CircleMinus, Lock, Sparkles, type LucideIcon } from 'lucide-react';

import { getAccentClasses, type UiAccent } from '@/components/DesignSystem';
import type { PostResourceBundleAccessMode } from '@/lib/post-resource-bundles';

// The app's choice, as its composer offers it (ugc-mobile/app/post/new.tsx):
// Free and Paid first, each with what it is for, so a creator sees that a
// recipe can be sold before choosing anything. No recipe is a card of the
// same shape rather than a row under the two, which read as a status line.
export const RECIPE_ACCESS_CHOICES: ReadonlyArray<{
  value: PostResourceBundleAccessMode;
  label: string;
  body: string;
  accent: UiAccent;
  icon: LucideIcon;
}> = [
  { value: 'free', label: 'Free recipe', body: 'Reward useful work', accent: 'workflow', icon: Sparkles },
  { value: 'paid', label: 'Paid recipe', body: 'Set a credit price', accent: 'commerce', icon: Lock },
  { value: 'none', label: 'No recipe', body: 'Just the post', accent: 'neutral', icon: CircleMinus },
];

/**
 * One choice of three for the post's recipe. Native radios, each a label
 * around a visually hidden input as the quick-publish modal's pill row is, so
 * the arrow keys move between the cards and Tab lands on the chosen one.
 */
export default function RecipeAccessCards({
  value,
  disabled = false,
  onChange,
}: {
  value: PostResourceBundleAccessMode;
  /** The cards show the mode and take nothing (a form that cannot change it). */
  disabled?: boolean;
  onChange: (mode: PostResourceBundleAccessMode) => void;
}) {
  // One group: what makes the arrow keys move between the cards.
  const name = useId();
  return (
    // Three columns once the group itself is wide enough for them (the
    // sidebar arrives at 768px, where the window's breakpoint still says
    // three), one column below that.
    <fieldset className="@container mt-4">
      <legend className="sr-only">Recipe access</legend>
      <div className="grid gap-3 @xl:grid-cols-3">
        {RECIPE_ACCESS_CHOICES.map((choice) => {
          const checked = choice.value === value;
          const accent = getAccentClasses(choice.accent);
          const Icon = choice.icon;
          return (
            <label
              key={choice.value}
              className={clsx(
                // The check mark's slot is always kept, so choosing a card
                // never narrows its text.
                'relative flex items-center gap-3 rounded-2xl border p-4 pr-10 transition-colors duration-150',
                // The input's keyboard focus draws the shared ring on the card.
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ui-focus)]/55 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[var(--ui-bg-app)]',
                checked
                  ? accent.selected
                  : clsx(
                    'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)]',
                    !disabled && 'hover:bg-[var(--ui-surface-3)]',
                  ),
                disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
              )}
            >
              <input
                type="radio"
                name={name}
                value={choice.value}
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(choice.value)}
                // Enter chooses the card, as the Free/Paid pills it replaces
                // did. Left to the browser, Enter on a radio submits the form:
                // Chrome skips the composer's disabled first submit button for
                // a non-text control and clicks the next one, "Save private".
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  if (!checked && !disabled) onChange(choice.value);
                }}
                className="sr-only"
              />
              <span className={clsx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full border', accent.iconWrap)}>
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[var(--ui-text-primary)]">{choice.label}</span>
                <span className="mt-0.5 block text-xs leading-5 text-[var(--ui-text-muted)]">{choice.body}</span>
              </span>
              {checked ? (
                <Check className={clsx('absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2', accent.mark)} aria-hidden="true" />
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
