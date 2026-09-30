import { useLocalSearchParams } from 'expo-router';

import { ContentPolicyGate } from '@/components/content-policy-gate';
import { MediaTemplateDetailScreen } from '@/components/media-template-screens';

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default function TemplateDetailRoute() {
  const { slug } = useLocalSearchParams<{ slug?: string | string[] }>();
  return (
    <ContentPolicyGate>
      <MediaTemplateDetailScreen slug={firstParam(slug) ?? ''} />
    </ContentPolicyGate>
  );
}
