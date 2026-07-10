import { RequireAuth } from '@/app/components/RouteAuthBoundary';

import CreateImageClient, { type CreateImagePrefill } from './CreateImageClient';

type CreateImagePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getFirstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CreateImagePage({
  searchParams,
}: CreateImagePageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const prefill: CreateImagePrefill = {
    remixId: getFirstValue(resolvedSearchParams.remix),
    remixPostId: getFirstValue(resolvedSearchParams.remixPost),
    prompt: getFirstValue(resolvedSearchParams.prompt),
    model: getFirstValue(resolvedSearchParams.model),
    aspectRatio: getFirstValue(resolvedSearchParams.aspectRatio),
  };
  const returnParams = new URLSearchParams();
  if (prefill.remixId) returnParams.set('remix', prefill.remixId);
  if (prefill.remixPostId) returnParams.set('remixPost', prefill.remixPostId);
  if (prefill.prompt) returnParams.set('prompt', prefill.prompt);
  if (prefill.model) returnParams.set('model', prefill.model);
  if (prefill.aspectRatio) returnParams.set('aspectRatio', prefill.aspectRatio);
  const returnTo = returnParams.size > 0
    ? `/create-image?${returnParams.toString()}`
    : '/create-image';

  return (
    <RequireAuth returnTo={returnTo}>
      <CreateImageClient prefill={prefill} />
    </RequireAuth>
  );
}
