import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { Copy, FileText, Heart, Lock, Repeat2, Share2 } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';

import { PostResourceBundleContent } from '@/components/post-resource-bundle-content';
import { Pill } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import type { PostResourceKind } from '@/lib/types';
import { accentColor, appTheme, type ToolAccent } from '@/lib/theme';
import { getSaveHeartIconProps } from '@/lib/viewer-actions';

/**
 * The details behind a post: stats, prompt, caption, actions and the creator's
 * unlock. Lifted out of the immersive viewer so the standalone post screen can
 * render the same page as its swipe-left half — one details surface, two hosts.
 */
export function PostDetailsPage({
  active,
  bottomInset,
  height,
  item,
  onRecreate,
  onSave,
  onShare,
  onUnlockRemix,
  saveLoading,
  sheet = false,
  topInset,
  width,
}: {
  active: boolean;
  bottomInset: number;
  height: number;
  item: ImmersivePreviewItem;
  onRecreate: (item: ImmersivePreviewItem) => void;
  onSave: (item: ImmersivePreviewItem) => void;
  onShare: (item: ImmersivePreviewItem) => void;
  onUnlockRemix: (item: ImmersivePreviewItem) => void;
  saveLoading: boolean;
  sheet?: boolean;
  topInset: number;
  width: number;
}) {
  const details = item.details;
  const unlock = details?.unlock ?? null;
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const [fileLoadingPath, setFileLoadingPath] = useState<string | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);

  const resourceQuery = useQuery({
    queryKey: ['post-resource-bundle', unlock?.postId, unlock?.resourceId],
    enabled: active && Boolean(unlock),
    queryFn: async () => {
      if (!unlock) throw new Error('Missing unlock details');
      return api.getMarketplaceResourceDetail(unlock.resourceId, { postId: unlock.postId });
    },
    staleTime: 1000 * 60,
  });

  const unlockMutation = useMutation({
    mutationFn: async () => {
      if (!unlock) return null;
      if (unlock.accessMode === 'free') {
        return api.unlockFreeBundle(unlock.postId);
      }
      return api.unlockBundleWithCredits(unlock.postId);
    },
    onSuccess: async () => {
      if (unlock) {
        await queryClient.invalidateQueries({ queryKey: ['post-resource-bundle', unlock.postId, unlock.resourceId] });
        await queryClient.invalidateQueries({ queryKey: ['marketplace-resource', unlock.resourceId] });
        await queryClient.invalidateQueries({ queryKey: ['marketplace-resources'] });
      }
      await Haptics.selectionAsync();
    },
  });

  const resolveResourceFileUrl = useCallback(async (storagePath: string) => {
    const postId = item.showcasePostId ?? item.ownerPostId ?? item.id;
    const response = await api.getPostResourceFileUrl(postId, storagePath);
    return response.signedUrl;
  }, [api, item.id, item.ownerPostId, item.showcasePostId]);

  const openResourceUrl = useCallback(async (url: string) => {
    setResourceError(null);
    await Linking.openURL(url);
  }, []);

  if (!details) {
    return <View style={{ width, height, backgroundColor: '#000' }} />;
  }

  const bundle = resourceQuery.data?.bundle;
  const canAccess = Boolean(bundle?.viewerCanAccess);
  const resources = canAccess ? bundle?.resources ?? null : null;
  const resourceKinds = bundle?.resourceKinds ?? unlock?.resourceKinds ?? [];

  const copyText = async (text: string) => {
    await Clipboard.setStringAsync(text);
    await Haptics.selectionAsync();
  };

  const openResourceFile = async ({ storagePath }: { storagePath: string; title: string; contentType: string | null }) => {
    try {
      setResourceError(null);
      setFileLoadingPath(storagePath);
      const signedUrl = await resolveResourceFileUrl(storagePath);
      await Linking.openURL(signedUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open this resource.';
      setResourceError(message);
    } finally {
      setFileLoadingPath(null);
    }
  };

  const unlockError = unlockMutation.error instanceof Error ? unlockMutation.error.message : null;
  const unlockAccent: ToolAccent = unlock?.accessMode === 'free' ? 'workflow' : 'commerce';
  const unlockPriceLabel = unlock ? bundle?.priceQuote?.formatted ?? unlock.priceLabel : null;
  const canRecreate = item.availableActions.includes('recreate');
  const canUnlockRemix = item.availableActions.includes('unlock-remix');
  const generationInfo = details?.generationInfo ?? null;

  return (
    <View style={{ width, height, backgroundColor: appTheme.colors.app }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: sheet ? 20 : topInset + 80,
          // The swipe page pins a "Swipe right for media" pill over the bottom-left
          // corner; the sheet has no such overlay, so only the page reserves room.
          paddingBottom: sheet ? bottomInset + 36 : bottomInset + 84,
          paddingHorizontal: 22,
          gap: appTheme.spacing.panel,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: 8 }}>
          <Text style={{ color: appTheme.colors.faint, ...appTheme.type.label, textTransform: 'uppercase' }}>
            {generationInfo ? 'Creation details' : 'Post details'}
          </Text>
          <Text selectable style={{ color: appTheme.colors.text, ...appTheme.type.pageTitle, fontWeight: '800' }}>
            {details.title}
          </Text>
          <Text style={{ color: appTheme.colors.textSecondary, ...appTheme.type.bodySm, fontWeight: '700' }}>
            {details.creatorLabel} · {details.categoryLabel}
          </Text>
        </View>

        {/* A creation has no saves or remixes of its own, so the stat row carries
            its production facts instead of zeroes. */}
        {generationInfo ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <DetailStat label="Model" value={generationInfo.model} />
            <DetailStat label="Created" value={formatGenerationDate(generationInfo.createdAt)} />
            <DetailStat
              label={generationInfo.duration ? 'Duration' : 'Cost'}
              value={generationInfo.duration
                ? `${generationInfo.duration}s`
                : generationInfo.cost != null ? `${generationInfo.cost}` : '—'}
            />
          </View>
        ) : (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <DetailStat label="Saves" value={formatCount(details.saveCount)} />
            <DetailStat label="Remixes" value={formatCount(details.remixCount)} />
            <DetailStat label="Source" value={details.sourceLabel} />
          </View>
        )}

        <DetailSection title="Prompt" emptyLabel="No prompt provided">
          {details.prompt ? (
            <CopyableText text={details.prompt} onCopy={copyText} />
          ) : null}
        </DetailSection>

        <DetailSection title="Caption" emptyLabel="No caption provided">
          {details.body ? (
            <CopyableText text={details.body} onCopy={copyText} />
          ) : null}
        </DetailSection>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {canRecreate ? (
            <DetailActionButton
              label="Recreate"
              icon={<Repeat2 size={18} color="#050505" strokeWidth={2.8} />}
              primary
              onPress={() => void onRecreate(item)}
            />
          ) : null}
          {canUnlockRemix && unlock ? (
            <DetailActionButton
              label="Remix"
              icon={<Repeat2 size={18} color="#050505" strokeWidth={2.8} />}
              primary
              onPress={() => onUnlockRemix(item)}
            />
          ) : null}
          <DetailActionButton
            disabled={!item.canSave}
            label={item.isSaved ? 'Saved' : 'Save'}
            icon={<Heart size={18} {...getSaveHeartIconProps({ isSaved: item.isSaved, enabled: item.canSave })} />}
            loading={saveLoading}
            onPress={() => onSave(item)}
          />
          <DetailActionButton
            disabled={!item.canShare}
            label="Share"
            icon={<Share2 size={18} color={item.canShare ? '#fff' : 'rgba(255,255,255,0.5)'} strokeWidth={2.5} />}
            onPress={() => void onShare(item)}
          />
        </View>

        <View style={{ borderRadius: appTheme.radii.xl, borderCurve: 'continuous', borderWidth: 1, borderColor: unlock ? `${accentColor(unlockAccent)}55` : appTheme.colors.border, backgroundColor: appTheme.colors.surfaceStrong, padding: appTheme.spacing.card, gap: appTheme.spacing.gap }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>Creator unlocks</Text>
              {unlock ? (
                <Text style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
                  {bundle?.previewText ?? unlock.previewText ?? 'Reusable resources are attached to this post.'}
                </Text>
              ) : (
                <Text style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
                  No unlock attached.
                </Text>
              )}
            </View>
            {unlock && unlockPriceLabel ? <Pill label={unlockPriceLabel} accent={unlockAccent} /> : null}
          </View>

          {unlock ? (
            <>
              <ResourceKindRow kinds={resourceKinds} />
              {resourceQuery.isLoading ? <ActivityIndicator color={appTheme.colors.primary} /> : null}
              {resourceQuery.error instanceof Error ? (
                <Text selectable style={{ color: '#ff8a9a', fontSize: 13, fontWeight: '700' }}>{resourceQuery.error.message}</Text>
              ) : null}
              <PostResourceBundleContent
                fileLoadingPath={fileLoadingPath}
                lockedPreview={bundle?.lockedPreview}
                mediaItems={item.mediaItems}
                onCopy={copyText}
                onError={setResourceError}
                onOpenFile={openResourceFile}
                onOpenUrl={openResourceUrl}
                resolveFileUrl={resolveResourceFileUrl}
                resources={resources}
              />
              {!resources ? (
                <View style={{ gap: 10 }}>
                  <DetailActionButton
                    label={!user ? 'Sign in to unlock' : unlock.accessMode === 'free' ? 'Get resources — Free' : 'Unlock with credits'}
                    icon={<Lock size={18} color="#050505" strokeWidth={2.8} />}
                    loading={unlockMutation.isPending}
                    primary
                    onPress={() => {
                      if (!user) {
                        router.push('/auth');
                        return;
                      }
                      unlockMutation.mutate();
                    }}
                  />
                  {unlockError ? <Text selectable style={{ color: '#ff8a9a', fontSize: 13, fontWeight: '700' }}>{unlockError}</Text> : null}
                </View>
              ) : null}
              {resourceError ? <Text selectable style={{ color: '#ff8a9a', fontSize: 13, fontWeight: '700' }}>{resourceError}</Text> : null}
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1, borderRadius: appTheme.radii.md, borderCurve: 'continuous', backgroundColor: appTheme.colors.surfaceStrong, padding: appTheme.spacing.gap, gap: 4 }}>
      <Text numberOfLines={1} style={{ color: appTheme.colors.faint, ...appTheme.type.caption, textTransform: 'uppercase' }}>{label}</Text>
      <Text numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  );
}

function DetailSection({ title, emptyLabel, children }: { title: string; emptyLabel: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>{title}</Text>
      {children || <Text style={{ color: appTheme.colors.faint, ...appTheme.type.bodySm }}>{emptyLabel}</Text>}
    </View>
  );
}

function CopyableText({ text, onCopy }: { text: string; onCopy: (text: string) => Promise<void> }) {
  return (
    <View style={{ borderRadius: appTheme.radii.md, borderCurve: 'continuous', backgroundColor: appTheme.colors.surface, padding: appTheme.spacing.gap, gap: appTheme.spacing.gap }}>
      <Text selectable style={{ color: appTheme.colors.textSecondary, ...appTheme.type.bodySm }}>{text}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Copy text"
        onPress={() => void onCopy(text)}
        style={({ pressed }) => ({ alignSelf: 'flex-start', minHeight: appTheme.touch.compact, flexDirection: 'row', alignItems: 'center', gap: 6, opacity: pressed ? 0.7 : 1, paddingHorizontal: 4 })}
      >
        <Copy size={15} color={appTheme.colors.success} strokeWidth={2.4} />
        <Text style={{ color: appTheme.colors.success, ...appTheme.type.caption, fontWeight: '800' }}>Copy</Text>
      </Pressable>
    </View>
  );
}

function DetailActionButton({
  disabled,
  icon,
  label,
  loading,
  onPress,
  primary,
}: {
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  loading?: boolean;
  onPress: () => void;
  primary?: boolean;
}) {
  const primaryColor = appTheme.colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: appTheme.touch.compact,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 22,
        backgroundColor: primary ? primaryColor : appTheme.colors.surfaceStrong,
        opacity: disabled ? 0.45 : pressed ? 0.76 : 1,
        paddingHorizontal: 15,
      })}
    >
      {loading ? <ActivityIndicator color={primary ? appTheme.colors.textInverse : appTheme.colors.text} /> : icon}
      <Text numberOfLines={1} style={{ color: primary ? appTheme.colors.textInverse : appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}

function ResourceKindRow({ kinds }: { kinds: PostResourceKind[] }) {
  if (!kinds.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {kinds.map((kind) => (
        <View key={kind} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: appTheme.radii.pill, backgroundColor: appTheme.colors.surfaceStrong, paddingHorizontal: 10, paddingVertical: 6 }}>
          <FileText size={13} color={appTheme.colors.textSecondary} strokeWidth={2.5} />
          <Text style={{ color: appTheme.colors.text, ...appTheme.type.caption, fontWeight: '800' }}>{resourceKindLabel(kind)}</Text>
        </View>
      ))}
    </View>
  );
}

function resourceKindLabel(kind: PostResourceKind) {
  if (kind === 'prompt') return 'Prompt';
  if (kind === 'workflow') return 'Workflow';
  if (kind === 'files') return 'Files';
  if (kind === 'notes') return 'Notes';
  return 'Remix';
}

function formatCount(value: number) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
  return String(value);
}

function formatGenerationDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
