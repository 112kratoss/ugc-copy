import Link from 'next/link';
import NavbarClient from '@/app/components/NavbarClient';

export default function Navbar() {
    return (
        <header className="w-full sticky top-0 z-50 transition-all duration-300 border-b border-white/[0.03] bg-zinc-950/70 backdrop-blur-xl supports-[backdrop-filter]:bg-zinc-950/40 text-white">
            <div className="max-w-7xl mx-auto px-6 h-16 flex justify-between items-center">
                <div className="flex items-center gap-2">
                    <Link href="/" className="text-xl font-bold tracking-tight text-white drop-shadow-sm hover:opacity-90 transition-opacity">
                        UGC copy
                    </Link>
                </div>

                <NavbarClient />
            </div>
        </header>
    );
}
