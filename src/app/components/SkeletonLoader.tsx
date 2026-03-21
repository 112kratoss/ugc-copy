'use client';

import { motion } from 'framer-motion';

export default function SkeletonLoader({ className = '' }: { className?: string }) {
    return (
        <div className={`relative overflow-hidden bg-zinc-900/30 rounded-2xl border border-white/5 backdrop-blur-sm ${className}`}>
            <motion.div
                className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/5 to-transparent"
                animate={{ translateX: ['-100%', '200%'] }}
                transition={{
                    repeat: Infinity,
                    duration: 1.5,
                    ease: 'linear',
                }}
            />
        </div>
    );
}
