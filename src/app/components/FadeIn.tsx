import { ReactNode } from 'react';

export function FadeInStagger({ 
    children, 
    className = '' 
}: { 
    children: ReactNode; 
    className?: string;
}) {
    return (
        <div className={className}>
            {children}
        </div>
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
        <div className={className}>
            {children}
        </div>
    );
}
