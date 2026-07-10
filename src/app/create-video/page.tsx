import { RequireAuth } from '@/app/components/RouteAuthBoundary';

import CreateVideoClient, { type CreateVideoPrefill } from './CreateVideoClient';

type CreateVideoPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getFirstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CreateVideoPage({
  searchParams,
}: CreateVideoPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const prefill: CreateVideoPrefill = {
    remixId: getFirstValue(resolvedSearchParams.remix),
    prompt: getFirstValue(resolvedSearchParams.prompt),
    model: getFirstValue(resolvedSearchParams.model),
    aspectRatio: getFirstValue(resolvedSearchParams.aspectRatio),
    duration: getFirstValue(resolvedSearchParams.duration),
  };
  const returnParams = new URLSearchParams();
  if (prefill.remixId) returnParams.set('remix', prefill.remixId);
  if (prefill.prompt) returnParams.set('prompt', prefill.prompt);
  if (prefill.model) returnParams.set('model', prefill.model);
  if (prefill.aspectRatio) returnParams.set('aspectRatio', prefill.aspectRatio);
  if (prefill.duration) returnParams.set('duration', prefill.duration);
  const returnTo = returnParams.size > 0
    ? `/create-video?${returnParams.toString()}`
    : '/create-video';

  return (
    <RequireAuth returnTo={returnTo}>
      <CreateVideoClient prefill={prefill} />
    </RequireAuth>
  );
}
