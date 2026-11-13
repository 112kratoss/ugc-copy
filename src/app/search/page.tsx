import type { Metadata } from 'next';

import { createMetadata } from '@/lib/seo';
import { searchDocumentTitle } from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';
import SearchClient from './SearchClient';
import { readSearchPageOpening } from './search-address';

type SearchPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

// The title carries the query, so history and the browser's tabs tell
// searches apart ("nano · Search | Magic Booklet"); the page keeps it in step
// as the person types (SearchClient).
export async function generateMetadata({ searchParams }: SearchPageProps): Promise<Metadata> {
  const resolved = searchParams ? await searchParams : {};
  const opening = readSearchPageOpening((name) => first(resolved[name]) ?? null);
  return createMetadata({
    title: searchDocumentTitle(opening.query),
    description: 'Find Magic Booklet creators, public posts, and reusable AI recipes.',
    path: '/search',
    noIndex: true,
  });
}

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
