import { router, useLocalSearchParams } from 'expo-router';

import { AiDataConsentOnOpen } from '@/components/ai-data-consent-on-open';
import { ContentPolicyGate } from '@/components/content-policy-gate';
import { MediaCreationScreen } from '@/components/media-creation-screen';
import type { CreatorToolId } from '@/lib/types';

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function isTool(value: unknown): value is CreatorToolId {
  return value === 'image' || value === 'video' || value === 'motion';
}

export default function CreateTabScreen() {
  const params = useLocalSearchParams<{
    tool?: string | string[];
    guided?: string | string[];
  }>();
  const requestedTool = firstParam(params.tool);
  const initialTool = isTool(requestedTool) ? requestedTool : 'image';
  const guided = firstParam(params.guided) === '1';

  return (
    <ContentPolicyGate chrome="tab">
      <AiDataConsentOnOpen />
      <MediaCreationScreen
        key={`${initialTool}:${guided ? 'guided' : 'standard'}`}
        initialTool={initialTool}
        insideTab
        guided={guided}
        onClose={() => {
          if (router.canGoBack()) router.back();
          else router.replace('/(tabs)' as never);
        }}
      />
    </ContentPolicyGate>
  );
}
