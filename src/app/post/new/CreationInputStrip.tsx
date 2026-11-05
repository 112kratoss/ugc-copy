'use client';

import { Film, Image as ImageIcon, Music, X } from 'lucide-react';

import type { GenerationReference } from '../../../../ugc-mobile/lib/creation-recipe/creation-recipe';

/**
 * A creation's saved inputs, small, in "From this creation": what "Include
 * creation references" would hand to whoever unlocks the recipe. Without
 * them in view the option read as nothing at all. Only the inputs the server
 * copies are drawn (`recipeCopyableInputs`), each by its kind.
 */
export default function CreationInputStrip({
  inputs,
  onRemove,
  removedCount = 0,
  onRestoreRemoved,
  filesLine = null,
}: {
  inputs: readonly GenerationReference[];
  /** Given, each input has a remove button (owner, 2026-11-05): the recipe then takes it no more. */
  onRemove?: (inputId: string) => void;
  /** How many the creator removed, put back all at once. */
  removedCount?: number;
  onRestoreRemoved?: () => void;
  /** Under the files while the recipe takes them: "Anyone who gets this recipe gets these files." */
  filesLine?: string | null;
}) {
  if (inputs.length === 0 && removedCount === 0) return null;

  return (
    <div>
      <div className="text-xs text-zinc-400">
        {inputs.length > 0 ? `${inputs.length} saved ${inputs.length === 1 ? 'input' : 'inputs'}` : 'No saved inputs go with this recipe.'}
      </div>
      {inputs.length > 0 ? (
        <ul aria-label="Saved inputs" className="mt-2 flex flex-wrap gap-2">
          {inputs.map((input) => (
            <li key={input.id} title={input.label} className="relative">
              <div
                className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-zinc-400"
              >
                {input.mediaKind === 'image' && input.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={input.url} alt={input.label} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                ) : (
                  <>
                    {input.mediaKind === 'video'
                      ? <Film className="h-5 w-5" aria-hidden="true" />
                      : input.mediaKind === 'audio'
                        ? <Music className="h-5 w-5" aria-hidden="true" />
                        : <ImageIcon className="h-5 w-5" aria-hidden="true" />}
                    <span className="sr-only">{input.label}</span>
                  </>
                )}
              </div>
              {onRemove ? (
                // A 32px press area over the corner; the mark inside is smaller.
                <button
                  type="button"
                  aria-label={`Remove ${input.label} from the recipe`}
                  onClick={() => onRemove(input.id)}
                  className="ui-focus-ring absolute -right-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-white/20 bg-black/80 text-white">
                    <X className="h-3 w-3" aria-hidden="true" />
                  </span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {filesLine || (removedCount > 0 && onRestoreRemoved) ? (
        <p className="mt-2 text-xs leading-5 text-zinc-400">
          {filesLine}
          {removedCount > 0 && onRestoreRemoved ? (
            <>
              {filesLine ? ' ' : null}
              <button
                type="button"
                onClick={onRestoreRemoved}
                className="ui-focus-ring font-semibold text-white underline decoration-white/40 underline-offset-4"
              >
                {removedCount === 1 ? 'Put the removed file back' : `Put the ${removedCount} removed files back`}
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
