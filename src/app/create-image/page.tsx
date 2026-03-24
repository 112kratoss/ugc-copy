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
    prompt: getFirstValue(resolvedSearchParams.prompt),
    model: getFirstValue(resolvedSearchParams.model),
    aspectRatio: getFirstValue(resolvedSearchParams.aspectRatio),
  };

  return <CreateImageClient prefill={prefill} />;
}
