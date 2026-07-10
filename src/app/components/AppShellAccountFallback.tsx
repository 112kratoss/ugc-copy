import Link from 'next/link';

export default function AppShellAccountFallback() {
  return (
    <Link
      href="/login?returnUrl=/create"
      className="ui-focus-ring inline-flex min-h-12 items-center justify-center rounded-full bg-[var(--ui-primary)] px-4 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985]"
    >
      Sign in
    </Link>
  );
}
