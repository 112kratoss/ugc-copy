import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

export const metadata: Metadata = {
  title: 'Admin — Magicbooklet',
  // The admin console must never enter an index, and Next's metadata robots
  // directive is belt-and-braces alongside the X-Robots-Tag set in src/proxy.ts.
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
