import { RequireAuth } from '@/app/components/RouteAuthBoundary';

import CreateMotionClient, { type CreateMotionPrefill } from './CreateMotionClient';

type CreateMotionPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getFirstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CreateMotionPage({
  searchParams,
}: CreateMotionPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const prefill: CreateMotionPrefill = {
    remixId: getFirstValue(resolvedSearchParams.remix),
    remixPostId: getFirstValue(resolvedSearchParams.remixPost),
    prompt: getFirstValue(resolvedSearchParams.prompt),
    model: getFirstValue(resolvedSearchParams.model),
  };
  const returnParams = new URLSearchParams();
  if (prefill.remixId) returnParams.set('remix', prefill.remixId);
  if (prefill.remixPostId) returnParams.set('remixPost', prefill.remixPostId);
  if (prefill.prompt) returnParams.set('prompt', prefill.prompt);
  if (prefill.model) returnParams.set('model', prefill.model);
  const returnTo = returnParams.size > 0
    ? `/create-motion?${returnParams.toString()}`
    : '/create-motion';

  return (
    <RequireAuth returnTo={returnTo}>
      <CreateMotionClient prefill={prefill} />
    </RequireAuth>
  );
}
