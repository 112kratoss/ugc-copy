export default function SkeletonLoader({ className = '' }: { className?: string }) {
    return (
        <div className={`relative overflow-hidden bg-zinc-900/30 rounded-2xl border border-white/5 backdrop-blur-sm ${className}`}>
            <div
                className="absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent"
                aria-hidden="true"
            />
        </div>
    );
}
