'use client';

import { motion } from 'framer-motion';
import { ReactNode } from 'react';

export function FadeInStagger({ 
    children, 
    className = '' 
}: { 
    children: ReactNode; 
    className?: string;
}) {
    return (
        <motion.div
            // Keep server-rendered content visible so the homepage is readable before hydration.
            initial={false}
            animate="visible"
            variants={{
                visible: {
                    transition: { staggerChildren: 0.15 }
                }
            }}
            className={className}
        >
            {children}
        </motion.div>
    );
}

export function FadeInItem({ 
    children, 
    className = '' 
}: { 
    children: ReactNode; 
    className?: string;
}) {
    return (
        <motion.div
            initial={false}
            variants={{
                visible: { 
                    opacity: 1, 
                    y: 0, 
                    transition: { type: 'spring', damping: 25, stiffness: 100 } 
                }
            }}
            className={className}
        >
            {children}
        </motion.div>
    );
}
