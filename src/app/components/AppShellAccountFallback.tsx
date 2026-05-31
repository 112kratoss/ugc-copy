import Link from 'next/link';

export default function AppShellAccountFallback() {
  return (
    <Link
      href="/login"
      className="inline-flex items-center justify-center rounded-full bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-zinc-200"
    >
      Start Creating
    </Link>
  );
}
