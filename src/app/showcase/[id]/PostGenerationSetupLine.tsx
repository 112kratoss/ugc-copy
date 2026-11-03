import { Fragment } from 'react';

import {
  describeGenerationSetup,
  generationSetupTerm,
  type GenerationSetupEntry,
} from '../../../../ugc-mobile/lib/generation-setup/generation-setup';

/**
 * The settings the post's creator chose for its creation, on a quiet line of
 * their own: "9:16 · 1K · JPG" (owner, 2026-11-03). Each value names its
 * setting on hover, and a screen reader hears them named, in the words the
 * app's Details uses (`generation-setup.ts`). The post page draws it under
 * Made with, and the mature-content gate with a post it revealed. Nothing where
 * the read sent none or could not read them: which posts have a line is the
 * read's call (`publicPostGenerationSetup`), never the page's.
 */
export default function PostGenerationSetupLine({
  entries,
  className = 'mt-2 text-xs text-zinc-500',
}: {
  entries: readonly GenerationSetupEntry[] | undefined;
  className?: string;
}) {
  if (!entries?.length) return null;
  return (
    <p data-testid="post-generation-setup" className={className}>
      <span className="sr-only">{describeGenerationSetup(entries)}</span>
      <span aria-hidden="true" className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {entries.map((entry, index) => (
          <Fragment key={entry.label}>
            {index > 0 ? <span>·</span> : null}
            <span title={entry.label}>{generationSetupTerm(entry)}</span>
          </Fragment>
        ))}
      </span>
    </p>
  );
}
