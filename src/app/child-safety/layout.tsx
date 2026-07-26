import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { createMetadata, siteConfig } from '@/lib/seo';

export const metadata: Metadata = createMetadata({
  title: 'Child Safety Standards',
  description: `Read ${siteConfig.name}'s child-safety standards and learn how to report suspected child exploitation or abuse.`,
  path: '/child-safety',
});

export default function ChildSafetyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
