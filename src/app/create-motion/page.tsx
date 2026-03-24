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
    prompt: getFirstValue(resolvedSearchParams.prompt),
    model: getFirstValue(resolvedSearchParams.model),
  };

  return <CreateMotionClient prefill={prefill} />;
}
