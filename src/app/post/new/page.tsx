import { RequireAuth } from '@/app/components/RouteAuthBoundary';

import NewPostClient from './NewPostClient';

type NewPostPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const RETURN_PARAM_KEYS = ['generationId', 'publishIntent', 'resourceMode', 'focus', 'from', 'returnTo'] as const;

function getFirstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function buildNewPostReturnPath(
  searchParams: Record<string, string | string[] | undefined>
): string {
  const returnParams = new URLSearchParams();
  for (const key of RETURN_PARAM_KEYS) {
    const value = getFirstValue(searchParams[key]);
    if (value) {
      returnParams.set(key, value);
    }
  }

  return returnParams.size > 0
    ? `/post/new?${returnParams.toString()}`
    : '/post/new';
}

export default async function NewPostPage({ searchParams }: NewPostPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const returnTo = buildNewPostReturnPath(resolvedSearchParams);

  return (
    <RequireAuth returnTo={returnTo}>
      <NewPostClient />
    </RequireAuth>
  );
}
