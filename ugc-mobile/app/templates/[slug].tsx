import { useLocalSearchParams } from 'expo-router';

import { MediaTemplateDetailScreen } from '@/components/media-template-screens';

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default function TemplateDetailRoute() {
  const { slug } = useLocalSearchParams<{ slug?: string | string[] }>();
  return <MediaTemplateDetailScreen slug={firstParam(slug) ?? ''} />;
}
