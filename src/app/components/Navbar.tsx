import Link from 'next/link';
import NavbarClient from '@/app/components/NavbarClient';

export default function Navbar() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/[0.03] bg-zinc-950/70 text-white backdrop-blur-xl transition-all duration-300 supports-[backdrop-filter]:bg-zinc-950/40">
      <div className="flex h-16 w-full items-center justify-between px-4 sm:px-6 lg:px-8 xl:px-10 2xl:px-12">
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className="text-xl font-bold tracking-tight text-white drop-shadow-sm transition-opacity hover:opacity-90"
          >
            UGC copy
          </Link>
        </div>

        <NavbarClient />
      </div>
    </header>
  );
}
