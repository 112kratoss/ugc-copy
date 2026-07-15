import Link from 'next/link';

import { OptimizedPreviewImage } from '@/app/components/OptimizedPreviewImage';
import { getUserInitials } from '@/lib/profile';
import type { ShowcaseCreator } from '@/lib/showcase';

interface CreatorIdentityProps {
  creator: ShowcaseCreator;
  compact?: boolean;
  prefetch?: boolean;
  usernamePrefix?: boolean;
}

export default function CreatorIdentity({
  creator,
  compact = false,
  prefetch,
  usernamePrefix = true,
}: CreatorIdentityProps) {
  const showSecondaryUsername =
    !!creator.username && creator.username.trim().toLowerCase() !== creator.name.trim().toLowerCase();

  const content = (
    <>
      {creator.avatar ? (
        <span
          className={`${compact ? 'h-8 w-8 text-[11px]' : 'h-10 w-10 text-xs'} relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/5 font-semibold text-zinc-200`}
        >
          <span aria-hidden="true">{getUserInitials(creator.name)}</span>
          <OptimizedPreviewImage
            previewSrc={creator.avatar}
            fallbackSrc={creator.avatar}
            fallbackToUnoptimized
            alt={`${creator.name} avatar`}
            sizes={compact ? '32px' : '40px'}
            className="object-cover"
          />
        </span>
      ) : (
        <div
          className={`${compact ? 'h-8 w-8 text-[11px]' : 'h-10 w-10 text-xs'} rounded-full border border-white/10 bg-white/5 text-zinc-200 flex items-center justify-center font-semibold`}
          aria-hidden="true"
        >
          {getUserInitials(creator.name)}
        </div>
      )}
      <div className="min-w-0">
        <div className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-white truncate`}>
          {creator.name}
        </div>
        {creator.username && showSecondaryUsername ? (
          <div className="text-xs text-zinc-400 truncate">
            {usernamePrefix ? `@${creator.username}` : creator.username}
          </div>
        ) : null}
      </div>
    </>
  );

  const className = `inline-flex items-center gap-3 min-w-0 ${creator.username ? 'hover:opacity-90 transition-opacity' : ''}`;

  if (!creator.username) {
    return <div className={className}>{content}</div>;
  }

  return (
    <Link href={`/creators/${creator.username}`} prefetch={prefetch} className={className}>
      {content}
    </Link>
  );
}
