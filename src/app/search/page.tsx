import type { Metadata } from 'next';

import { createMetadata } from '@/lib/seo';
import SearchClient from './SearchClient';
import { readSearchPageOpening } from './search-address';

type SearchPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export const metadata: Metadata = createMetadata({
  title: 'Search',
  description: 'Find Magic Booklet creators, public posts, and reusable AI recipes.',
  path: '/search',
  noIndex: true,
});

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const resolved = searchParams ? await searchParams : {};
  // Read as the page itself reads its address when history brings it back.
  const opening = readSearchPageOpening((name) => first(resolved[name]) ?? null);

  return (
    <SearchClient
      initialQuery={opening.query}
      initialType={opening.type}
      initialSort={opening.sort}
      initialFilters={opening.filters}
      initialExact={opening.exact}
    />
  );
}
