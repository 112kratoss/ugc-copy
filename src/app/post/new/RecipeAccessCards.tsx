'use client';

import clsx from 'clsx';
import { Check, CircleMinus, Lock, Sparkles, type LucideIcon } from 'lucide-react';

import { getAccentClasses, type UiAccent } from '@/components/DesignSystem';
import type { PostResourceBundleAccessMode } from '@/lib/post-resource-bundles';

// The app's choice, as its composer draws it (ugc-mobile/app/post/new.tsx):
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
  { value: 'paid', label: 'Paid recipe', body: 'Set a token price', accent: 'commerce', icon: Lock },
  { value: 'none', label: 'No recipe', body: 'Just the post', accent: 'neutral', icon: CircleMinus },
];

/**
 * One choice of three for the post's recipe. Native radios, each a label
 * around a visually hidden input as the quick-publish modal's pill row is, so
 * the arrow keys move between the cards and Tab lands on the chosen one.
 */
export default function RecipeAccessCards({
  name,
  value,
  disabled = false,
  onChange,
}: {
  /** The radio group's name: one composer, one group. */
  name: string;
  value: PostResourceBundleAccessMode;
  /** A bundle someone has paid for keeps its mode: the cards show it and take nothing. */
  disabled?: boolean;
  onChange: (mode: PostResourceBundleAccessMode) => void;
}) {
  const idle = getAccentClasses('neutral').tile;
  return (
    <fieldset className="mt-4">
      <legend className="sr-only">Recipe access</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        {RECIPE_ACCESS_CHOICES.map((choice) => {
          const checked = choice.value === value;
          const accent = getAccentClasses(choice.accent);
          const Icon = choice.icon;
          return (
            <label
              key={choice.value}
              className={clsx(
                'relative flex items-center gap-3 rounded-2xl border p-4 transition-colors',
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--ui-focus)]',
                checked ? accent.tileActive : idle,
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
                className="sr-only"
              />
              <span className={clsx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full border', accent.iconWrap)}>
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[var(--ui-text-primary)]">{choice.label}</span>
                <span className="mt-0.5 block text-xs leading-5 text-[var(--ui-text-muted)]">{choice.body}</span>
              </span>
              {checked ? <Check className={clsx('h-4 w-4 shrink-0', accent.mark)} aria-hidden="true" /> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
