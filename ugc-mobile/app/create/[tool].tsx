import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigation, usePreventRemove, useRoute } from '@react-navigation/native';
import { router, Stack } from 'expo-router';

import { AiDataConsentOnOpen } from '@/components/ai-data-consent-on-open';
import { ContentPolicyGate } from '@/components/content-policy-gate';
import { MediaCreationScreen } from '@/components/media-creation-screen';
import { PrimaryButton, Screen, SecondaryButton, SectionTitle } from '@/components/ui';
import { findRemixLaunch } from '@/lib/remix-start';
import type { CreatorToolId } from '@/lib/types';

const subscribeToNoRemixLaunch = () => () => undefined;

function closeCreateRoute() {
  if (router.canGoBack()) router.back();
  else router.replace('/(tabs)' as never);
}

function isTool(value: unknown): value is CreatorToolId {
  return value === 'image' || value === 'video' || value === 'motion';
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default function CreateToolScreen() {
  // The route's own params: the URL parse has decoded them once, as every link encoded its text
  // once. expo-router's `useLocalSearchParams` decodes them again, which turned each valid %XX in
  // a prompt, a source title or a poster URL into another character ("50%50" read "50P").
  const route = useRoute();
  const params = (route.params ?? {}) as {
    tool?: string | string[];
    prompt?: string | string[];
    remix?: string | string[];
    remixPost?: string | string[];
    guided?: string | string[];
    sourceTitle?: string | string[];
    sourceCreator?: string | string[];
    sourceThumbnail?: string | string[];
    // `REMIX_LAUNCH_PARAM`: the Remix tap that opened this creator before its start was answered.
    remixLaunch?: string | string[];
  };
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
  // A Remix tap opens this route before its start is answered. The creator follows the
  // answer, but on a first run the community rules stand in front of it and it is not
  // open: a refused start then sat under its dialog, and an unlock sheet opened under
  // this route. The route takes the way out whenever the creator has not
  // (`claimExit`; an open creator's effects run first).
  const [remixLaunch] = useState(() => findRemixLaunch(firstParam(params.remixLaunch), {
    generationId: firstParam(params.remix),
    postId: firstParam(params.remixPost),
  }));
  const remixAnswer = useSyncExternalStore(remixLaunch?.subscribe ?? subscribeToNoRemixLaunch, () => remixLaunch?.answer ?? null);
  useEffect(() => {
    if (!remixLaunch || !remixAnswer || remixAnswer.kind === 'confirmed' || !remixLaunch.claimExit()) return;
    if (remixAnswer.kind === 'replaced') router.replace(remixAnswer.href as never);
    else closeCreateRoute();
  }, [remixAnswer, remixLaunch]);
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
      <ContentPolicyGate chrome="headerless">
        <AiDataConsentOnOpen />
        <MediaCreationScreen
          key={`${initialTool}:${remixId ?? ''}:${remixPostId ?? ''}:${initialPrompt ?? ''}`}
          initialTool={initialTool}
          initialPrompt={initialPrompt}
          remixSource={remixSource}
          remixLaunchId={firstParam(params.remixLaunch)}
          // Each navigation here opens its remix from the source; one keyed afresh on this route resumes it.
          remixOpening={route.key}
          guided={guided}
          registerBeforeClose={registerBeforeClose}
          onDirtyChange={setDirty}
          onClose={closeCreateRoute}
        />
      </ContentPolicyGate>
    </>
  );
}
