import { useLocalSearchParams } from 'expo-router';

import { MediaTemplateRunScreen } from '@/components/media-template-screens';

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default function TemplateRunRoute() {
  const { runId } = useLocalSearchParams<{ runId?: string | string[] }>();
  return <MediaTemplateRunScreen runId={firstParam(runId) ?? ''} />;
}
