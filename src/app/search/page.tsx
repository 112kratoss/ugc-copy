import type { Metadata } from 'next';

import { createMetadata } from '@/lib/seo';
import { normalizePublicSearchQuery, parsePublicSearchType } from '@/lib/public-search';
import SearchClient from './SearchClient';

type SearchPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export const metadata: Metadata = createMetadata({
  title: 'Search',
  description: 'Find Magicbooklet creators, public posts, and reusable AI recipes.',
  path: '/search',
  noIndex: true,
});

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const resolved = searchParams ? await searchParams : {};
  const initialQuery = normalizePublicSearchQuery(first(resolved.q));
  const initialType = parsePublicSearchType(first(resolved.type)) ?? 'top';

  return <SearchClient initialQuery={initialQuery} initialType={initialType} />;
}
