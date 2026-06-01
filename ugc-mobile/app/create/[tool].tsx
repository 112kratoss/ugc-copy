import { useLocalSearchParams } from 'expo-router';

import { MediaCreationScreen } from '@/components/media-creation-screen';
import type { CreatorToolId } from '@/lib/types';

function isTool(value: unknown): value is CreatorToolId {
  return value === 'image' || value === 'video' || value === 'motion';
}

export default function CreateToolScreen() {
  const params = useLocalSearchParams<{ tool?: string }>();
  const initialTool = isTool(params.tool) ? params.tool : 'image';

  return <MediaCreationScreen key={initialTool} initialTool={initialTool} />;
}
