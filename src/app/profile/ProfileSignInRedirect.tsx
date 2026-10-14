'use client';

import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * Sends a signed-out visitor to sign in, and back to the /profile page they
 * asked for afterwards, its query included. A layout is never told which page
 * it wraps; the browser knows the address.
 */
export default function ProfileSignInRedirect() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const query = searchParams.toString();
    const returnPath = query ? `${pathname}?${query}` : pathname;
    router.replace(`/login?returnUrl=${encodeURIComponent(returnPath)}`);
  }, [pathname, router, searchParams]);

  return (
    <p role="status" className="px-6 py-16 text-center text-sm text-zinc-400">
      Taking you to sign in…
    </p>
  );
}
