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

  return <CreateVideoClient prefill={prefill} />;
}
