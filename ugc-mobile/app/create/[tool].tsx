import { useCallback, useRef, useState } from 'react';
import { useNavigation, usePreventRemove } from '@react-navigation/native';
import { router, Stack, useLocalSearchParams } from 'expo-router';

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
    guided?: string | string[];
    sourceTitle?: string | string[];
    sourceCreator?: string | string[];
    sourceThumbnail?: string | string[];
  }>();
  const beforeClose = useRef<(() => Promise<boolean>) | null>(null);
  const navigation = useNavigation();
  const [dirty, setDirty] = useState(false);
  const registerBeforeClose = useCallback((guard: (() => Promise<boolean>) | null) => { beforeClose.current = guard; }, []);
  // Only an edited session is worth stopping. Guarding a clean one would make
  // every exit wait on a promise for nothing.
  usePreventRemove(dirty, ({ data }) => {
    void (beforeClose.current?.() ?? Promise.resolve(true)).then((leave) => {
      if (leave) navigation.dispatch(data.action);
    });
  });
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
  const guided = firstParam(params.guided) === '1';
  const remixSource = remixId || remixPostId
    ? {
        ...(remixId ? { generationId: remixId } : {}),
        postId: remixPostId ?? null,
        ...(firstParam(params.sourceTitle) ? { title: firstParam(params.sourceTitle) } : {}),
        ...(firstParam(params.sourceCreator) ? { creatorLabel: firstParam(params.sourceCreator) } : {}),
        ...(firstParam(params.sourceThumbnail) ? { thumbnailUrl: firstParam(params.sourceThumbnail) } : {}),
      }
    : undefined;

  return (
    <>
      {/* A native-stack pop finishes before JS is asked, so `usePreventRemove`
          cannot hold the screen against a back gesture — the draft flush and
          the "save failed, keep editing?" choice would both be skipped. The
          full-screen pan iOS 26 added is off statically in `app/_layout.tsx`;
          this withdraws the edge swipe too, for exactly as long as there is an
          edit to lose. An untouched session keeps it, and ✕ always works. */}
      <Stack.Screen options={{ gestureEnabled: !dirty }} />
      <MediaCreationScreen
        key={`${initialTool}:${remixId ?? ''}:${remixPostId ?? ''}:${initialPrompt ?? ''}`}
        initialTool={initialTool}
        initialPrompt={initialPrompt}
        remixSource={remixSource}
        guided={guided}
        registerBeforeClose={registerBeforeClose}
        onDirtyChange={setDirty}
        onClose={() => {
          if (router.canGoBack()) router.back();
          else router.replace('/(tabs)' as never);
        }}
      />
    </>
  );
}
