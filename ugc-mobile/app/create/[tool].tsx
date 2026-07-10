import { router, useLocalSearchParams } from 'expo-router';

import { MediaCreationScreen } from '@/components/media-creation-screen';
import { PrimaryButton, Screen, SecondaryButton, SectionTitle } from '@/components/ui';
import type { CreatorToolId } from '@/lib/types';

function isTool(value: unknown): value is CreatorToolId {
  return value === 'image' || value === 'video' || value === 'motion';
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default function CreateToolScreen() {
  const params = useLocalSearchParams<{
    tool?: string | string[];
    prompt?: string | string[];
    remix?: string | string[];
    remixPost?: string | string[];
  }>();
  const initialToolParam = firstParam(params.tool);
  if (!isTool(initialToolParam)) {
    return (
      <Screen>
        <SectionTitle eyebrow="Create" title="That creation mode is unavailable" body="Choose Image, Video, or Motion to continue." />
        <PrimaryButton label="Open Image creator" accent="primary" onPress={() => router.replace('/create/image' as never)} />
        <SecondaryButton label="Go home" onPress={() => router.replace('/(tabs)' as never)} />
      </Screen>
    );
  }
  const initialTool = initialToolParam;
  const initialPrompt = firstParam(params.prompt);
  const remixId = firstParam(params.remix);
  const remixPostId = firstParam(params.remixPost);
  const remixSource = remixId
    ? {
        generationId: remixId,
        postId: remixPostId ?? null,
      }
    : undefined;

  return (
    <MediaCreationScreen
      key={`${initialTool}:${remixId ?? ''}:${remixPostId ?? ''}:${initialPrompt ?? ''}`}
      initialTool={initialTool}
      initialPrompt={initialPrompt}
      remixSource={remixSource}
    />
  );
}
