import { OptimizedPreviewImage } from '@/components/OptimizedPreviewImage';
import { getUserInitials } from '@/lib/profile';

/**
 * Small round avatar for comment rows and the composer. Initials are always
 * rendered underneath so a slow or broken image never leaves an empty circle.
 * A name still being read (null) draws none: the circle stays blank rather than
 * showing an initial that then changes (the composer's, `accountAvatar`).
 */
export default function PostCommentAvatar({
    avatarUrl,
    name,
    size = 28,
}: {
    avatarUrl: string | null;
    name: string | null;
    size?: number;
}) {
    return (
        <span
            className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[10px] font-bold text-[var(--ui-text-secondary)]"
            style={{ width: size, height: size }}
        >
            {name === null ? null : <span aria-hidden="true">{getUserInitials(name)}</span>}
            {avatarUrl ? (
                <OptimizedPreviewImage
                    previewSrc={avatarUrl}
                    fallbackSrc={avatarUrl}
                    fallbackToUnoptimized
                    alt=""
                    sizes={`${size}px`}
                    className="object-cover"
                />
            ) : null}
        </span>
    );
}
