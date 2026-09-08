import { AlertTriangle } from 'lucide-react';

/**
 * The explicit state for media whose only source is known to be gone
 * (`source_unavailable_at`, 20260908061500 migration). It replaces the
 * loader-then-retry loop those records used to produce: the address the API
 * withholds could never load, so a retry control would be a lie.
 */
export default function UnavailableMediaNote({
    testId,
    className = 'aspect-[4/5] w-full',
}: {
    testId?: string;
    className?: string;
}) {
    return (
        <div
            data-testid={testId}
            role="note"
            className={`flex flex-col items-center justify-center gap-2 bg-zinc-950 px-5 text-center text-zinc-500 ${className}`}
        >
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            <span className="text-xs font-medium">This file is no longer available</span>
            <span className="text-[11px] text-zinc-600">Its only copy expired at the provider before it could be saved.</span>
        </div>
    );
}
