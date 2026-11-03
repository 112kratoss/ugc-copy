'use client';

import { Film, Image as ImageIcon, Music } from 'lucide-react';

export interface CreationInputStripItem {
  id: string;
  mediaType: 'image' | 'video' | 'audio' | 'other';
  url: string | null;
  label: string;
}

/**
 * A creation's saved inputs, small, in "From this creation": what "Include
 * creation references" would hand to whoever unlocks the recipe. Without
 * them in view the option read as nothing at all.
 */
export default function CreationInputStrip({ inputs }: { inputs: CreationInputStripItem[] }) {
  if (inputs.length === 0) return null;

  return (
    <div>
      <div className="text-xs text-zinc-400">
        {`${inputs.length} saved ${inputs.length === 1 ? 'input' : 'inputs'}`}
      </div>
      <ul aria-label="Saved inputs" className="mt-2 flex flex-wrap gap-2">
        {inputs.map((input) => (
          <li
            key={input.id}
            title={input.label}
            className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-white/[0.04] text-zinc-400"
          >
            {input.mediaType === 'image' && input.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={input.url} alt={input.label} loading="lazy" decoding="async" className="h-full w-full object-cover" />
            ) : (
              <>
                {input.mediaType === 'video'
                  ? <Film className="h-5 w-5" aria-hidden="true" />
                  : input.mediaType === 'audio'
                    ? <Music className="h-5 w-5" aria-hidden="true" />
                    : <ImageIcon className="h-5 w-5" aria-hidden="true" />}
                <span className="sr-only">{input.label}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
