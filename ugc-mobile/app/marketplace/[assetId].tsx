import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { Linking, Text, View } from 'react-native';

import { MediaPreview } from '@/components/media-preview';
import { Card, PrimaryButton, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import { appTheme } from '@/lib/theme';

function resourceLabel(kinds?: string[]) {
  if (!kinds || kinds.length === 0) return 'Creator unlock';
  return kinds.map((kind) => kind[0]?.toUpperCase() + kind.slice(1)).join(' · ');
}

export default function MarketplaceAssetScreen() {
  const { assetId, postId } = useLocalSearchParams<{ assetId: string; postId?: string }>();
  const resourceId = Array.isArray(assetId) ? assetId[0] : assetId;
  const fallbackPostId = Array.isArray(postId) ? postId[0] : postId;
  const { user, api, credits, updateCredits } = useAuth();
  const queryClient = useQueryClient();
  const webUrl = `${env.siteUrl}/marketplace/${resourceId}`;

  const detailQuery = useQuery({
    queryKey: ['marketplace-resource', resourceId, fallbackPostId, user?.id],
    enabled: Boolean(resourceId),
    queryFn: async () => (await api.getMarketplaceResourceDetail(resourceId, { postId: fallbackPostId })).bundle,
  });

  const unlockMutation = useMutation({
    mutationFn: async () => {
      const detail = detailQuery.data;
      if (!detail?.postId) throw new Error('Missing post for unlock.');
      if (detail.accessMode === 'free') {
        return api.unlockFreeBundle(detail.postId);
      }
      return api.unlockBundleWithCredits(detail.postId);
    },
    onSuccess: async (result) => {
      if ('credits' in result && typeof result.credits === 'number') {
        updateCredits(result.credits);
      }
      await queryClient.invalidateQueries({ queryKey: ['marketplace-resource', resourceId] });
      await queryClient.invalidateQueries({ queryKey: ['marketplace-resources'] });
    },
  });

  const detail = detailQuery.data;
  const resources = detail?.resources;

  return (
    <Screen>
      <SectionTitle
        eyebrow="Unlock detail"
        title={detail?.title ?? 'Creator unlock'}
        body={detail ? `${resourceLabel(detail.resourceKinds)} · ${detail.seller?.name ?? detail.creator?.name ?? 'Creator'}` : 'Loading unlock details.'}
      />

      {detailQuery.error ? (
        <StatusBlock
          tone="danger"
          title="Could not load unlock"
          body={detailQuery.error instanceof Error ? detailQuery.error.message : 'Try again.'}
        />
      ) : null}
      {unlockMutation.error ? (
        <StatusBlock
          tone="danger"
          title="Unlock failed"
          body={unlockMutation.error instanceof Error ? unlockMutation.error.message : 'Try again.'}
        />
      ) : null}

      {detail ? (
        <>
          <Card accent={detail.accessMode === 'free' ? 'workflow' : 'amber'}>
            <MediaPreview url={detail.post?.mediaUrl ?? detail.mediaUrl ?? null} kind={detail.post?.mediaKind ?? null} />
            <View style={{ gap: 8 }}>
              <Text style={{ color: appTheme.colors.success, fontWeight: '800' }}>
                {detail.accessMode === 'free' ? 'Free unlock' : detail.priceQuote?.formatted ?? 'Paid unlock'}
              </Text>
              <Text selectable style={{ color: appTheme.colors.text, fontSize: 16, lineHeight: 23 }}>
                {detail.summary ?? detail.description ?? detail.previewText ?? 'Reusable creator resource.'}
              </Text>
              <Text selectable style={{ color: appTheme.colors.muted, lineHeight: 21 }}>
                {detail.previewText ?? 'Unlock includes creator-facing resources for this post.'}
              </Text>
            </View>
          </Card>

          {detail.viewerCanAccess && resources ? (
            <Card accent="workflow">
              <Text style={{ color: appTheme.colors.text, fontSize: 18, fontWeight: '800' }}>Unlocked resources</Text>
              {resources.promptText ? (
                <Text selectable style={{ color: appTheme.colors.text, lineHeight: 22 }}>
                  {resources.promptText}
                </Text>
              ) : null}
              {resources.notesMarkdown ? (
                <Text selectable style={{ color: appTheme.colors.muted, lineHeight: 22 }}>
                  {resources.notesMarkdown}
                </Text>
              ) : null}
              {resources.attachments.length > 0 ? (
                <View style={{ gap: 8 }}>
                  {resources.attachments.map((attachment) => (
                    <Text key={`${attachment.label}-${attachment.url ?? attachment.storagePath ?? ''}`} selectable style={{ color: appTheme.colors.muted }}>
                      {attachment.kind ?? 'file'} · {attachment.label}
                    </Text>
                  ))}
                </View>
              ) : null}
              {resources.workflowShareUrl || resources.workflowSnapshot ? (
                <View style={{ gap: 4 }}>
                  <Text style={{ color: appTheme.colors.text, fontWeight: '800' }}>Workflow is web-first</Text>
                  <Text style={{ color: appTheme.colors.muted, lineHeight: 20 }}>
                    Workflow snapshots can be viewed from mobile, but importing and editing stays on the web canvas in v1.
                  </Text>
                </View>
              ) : null}
            </Card>
          ) : null}

          <Card>
            {!user ? (
              <View style={{ gap: 4 }}>
                <Text style={{ color: appTheme.colors.text, fontWeight: '800' }}>Sign in required</Text>
                <Text style={{ color: appTheme.colors.muted, lineHeight: 20 }}>Sign in before unlocking free or paid resources.</Text>
              </View>
            ) : null}
            {detail.viewerCanAccess ? (
              <View style={{ gap: 4 }}>
                <Text style={{ color: appTheme.colors.success, fontWeight: '800' }}>Unlocked</Text>
                <Text style={{ color: appTheme.colors.muted, lineHeight: 20 }}>This resource is available on your account.</Text>
              </View>
            ) : detail.accessMode === 'free' ? (
              <PrimaryButton
                label={unlockMutation.isPending ? 'Unlocking...' : 'Unlock free resources'}
                loading={unlockMutation.isPending}
                onPress={() => {
                  if (!user) {
                    router.push('/auth');
                    return;
                  }
                  unlockMutation.mutate();
                }}
                accent="workflow"
              />
            ) : (
              <View style={{ gap: 10 }}>
                <View style={{ gap: 4 }}>
                  <Text style={{ color: appTheme.colors.text, fontWeight: '800' }}>Unlock with credits</Text>
                  <Text style={{ color: appTheme.colors.muted, lineHeight: 20 }}>
                    Paid mobile unlocks now use your Magic Booklet credit balance instead of a separate store checkout.
                  </Text>
                  <Text style={{ color: appTheme.colors.success, fontWeight: '800' }}>
                    Costs {detail.priceUsdCents ?? 0} credits • Balance {credits ?? 0}
                  </Text>
                </View>
                <PrimaryButton
                  label={unlockMutation.isPending ? 'Unlocking...' : `Unlock for ${detail.priceUsdCents ?? 0} credits`}
                  loading={unlockMutation.isPending}
                  onPress={() => {
                    if (!user) {
                      router.push('/auth');
                      return;
                    }
                    unlockMutation.mutate();
                  }}
                  accent="amber"
                />
              </View>
            )}
            <SecondaryButton label="Open listing on web" onPress={() => void Linking.openURL(webUrl)} />
          </Card>
        </>
      ) : !detailQuery.isLoading ? (
        <StatusBlock title="Unlock unavailable" body="This resource may be unlisted, private, or removed." />
      ) : null}
    </Screen>
  );
}
