import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Copy, FileText, Lock, MessageCircle, MoreVertical, Repeat2 } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';

import { ResourcePrompt } from '@/components/resource-prompt';
import { PostResourceBundleContent } from '@/components/post-resource-bundle-content';
import { ResourceAction } from '@/components/resource-action';
import { CreatorAvatar, Pill } from '@/components/ui';
import { SaveHeart } from '@/components/save-heart';
import { useAuth } from '@/lib/auth';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { formatCompactCount } from '@/lib/home-view-model';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import {
  buildGenerationStats,
  buildPostDetailsMeta,
  getDetailsBackLabel,
  getDetailsPrimaryAction,
  getDetailsTitle,
  getResourceSectionState,
  getUnlockPriceLabel,
  prepareUnlockedResourcesForDetails,
} from '@/lib/post-details-view-model';
import { BackGlyph, ShareGlyph } from '@/lib/platform-glyphs';
import type { PostResourceKind } from '@/lib/types';
import { accentColor, appTheme, type ToolAccent } from '@/lib/theme';
import { refreshUnlockedBundleCaches } from '@/lib/unlock-cache';
import { verticalHitSlop } from '@/lib/hit-target';
import { haptic } from '@/lib/haptics';

/** The creator byline reads as a single line of text; its reach is widened rather than its height. */
const CREATOR_ROW_HEIGHT = 36;

/**
 * A composed title is capped at 100 characters, which is five or six lines of
 * the display face — so this bound never touches one. What it catches is a
 * creation whose "title" is its whole prompt: a fifteen-line script set at 30pt
 * pushed the creator, the facts and every action below the fold, and Layout is
 * explicit that essential information must not be crowded out by a detail that
 * is "available in other parts of the window" — this one is, in full, in the
 * Prompt section directly beneath it.
 */
const DETAILS_TITLE_MAX_LINES = 6;

/**
 * The details behind a post: who made it, the prompt, the caption, and the
 * creator's unlockable resources. One surface, two hosts — the reel's
 * swipe-left page and the text post screen's second page — so it carries its
 * own header and its own way back.
 */
export function PostDetailsPage({
  active,
  bottomInset,
  height,
  hostRendersPostText = false,
  item,
  onActionsOpen,
  onBack,
  onComments,
  onCreatorOpen,
  onRecreate,
  onSave,
  onShare,
  remixLoading,
  saveLoading,
  topInset,
  width,
}: {
  active: boolean;
  bottomInset: number;
  height: number;
  /**
   * True when the host already shows the post's title and body in full — the
   * text post page does. Over the reel, where the details page is the only
   * place the post is named without truncation, it does not.
   */
  hostRendersPostText?: boolean;
  item: ImmersivePreviewItem;
  onActionsOpen?: () => void;
  onBack?: () => void;
  onComments?: () => void;
  onCreatorOpen?: (item: ImmersivePreviewItem) => void;
  onRecreate: (item: ImmersivePreviewItem) => void;
  onSave: (item: ImmersivePreviewItem) => void;
  onShare: (item: ImmersivePreviewItem) => void;
  remixLoading?: boolean;
  saveLoading: boolean;
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
      if (unlock) await refreshUnlockedBundleCaches(queryClient, unlock);
      haptic.select();
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
    return <View style={{ width, height, backgroundColor: appTheme.colors.app }} />;
  }

  const bundle = resourceQuery.data?.bundle;
  const sectionState = getResourceSectionState({
    hasUnlock: Boolean(unlock),
    bundle,
    isError: resourceQuery.isError,
  });
  const canAccess = sectionState === 'unlocked';
  const resourceKinds = bundle?.resourceKinds ?? unlock?.resourceKinds ?? [];
  const prepared = canAccess && bundle?.resources
    ? prepareUnlockedResourcesForDetails(bundle.resources, { detailsPrompt: details.prompt })
    : null;

  const copyText = (text: string) => copyToClipboard(text);

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
  const unlockPriceLabel = getUnlockPriceLabel(unlock, bundle);
  const primaryAction = getDetailsPrimaryAction(item, { canAccess });
  const generationStats = buildGenerationStats(details.generationInfo ?? null);
  const meta = buildPostDetailsMeta(item);
  const canOpenCreator = Boolean(onCreatorOpen && item.creatorUsername);
  const commentCount = Math.max(0, item.commentCount ?? 0);
  // A text post derives both `prompt` and `body` from the same paragraph, so
  // showing the caption after the host already printed it prints it twice.
  const captionText = hostRendersPostText
    && normalizeComparable(details.body) === normalizeComparable(item.displayText)
    ? ''
    : details.body;

  return (
    <View style={{ width, height, backgroundColor: appTheme.colors.app }}>
      <DetailsHeader
        backLabel={getDetailsBackLabel(item)}
        onActionsOpen={onActionsOpen}
        onBack={onBack}
        title={getDetailsTitle(item)}
        topInset={topInset}
      />
      <ScrollView
        contentContainerStyle={{
          paddingTop: 8,
          paddingBottom: bottomInset + 36,
          paddingHorizontal: 22,
          gap: appTheme.spacing.panel,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: 10 }}>
          {hostRendersPostText ? null : (
            <Text
              numberOfLines={DETAILS_TITLE_MAX_LINES}
              selectable
              style={{ color: appTheme.colors.text, ...appTheme.type.pageTitle, fontWeight: '800' }}
            >
              {details.title}
            </Text>
          )}
          <Pressable
            accessibilityRole={canOpenCreator ? 'button' : undefined}
            accessibilityLabel={canOpenCreator ? `Open ${meta.creatorLabel} profile` : undefined}
            disabled={!canOpenCreator}
            onPress={() => onCreatorOpen?.(item)}
            hitSlop={verticalHitSlop(CREATOR_ROW_HEIGHT)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 9,
              minHeight: CREATOR_ROW_HEIGHT,
              alignSelf: 'flex-start',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <CreatorAvatar name={meta.creatorLabel} uri={details.creatorAvatar} size={28} />
            <Text numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>
              {meta.creatorLabel}
            </Text>
            {meta.timeLabel ? (
              <Text style={{ color: appTheme.colors.faint, ...appTheme.type.bodySm }}>
                {`· ${meta.timeLabel}`}
              </Text>
            ) : null}
          </Pressable>
          {meta.metaParts.length > 0 ? (
            <Text style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
              {meta.metaParts.join(' · ')}
            </Text>
          ) : null}
        </View>

        {/* A creation's production facts are real information; a post's
            "0 saves · 0 remixes · Showcase" was not.
            Cost used to be the fallback for a missing duration, so a video —
            the expensive kind — never showed what it had cost. Each fact now
            takes its own tile, and the row wraps rather than squeezing three
            of them into a phone's width. */}
        {generationStats.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {generationStats.map((stat) => (
              <DetailStat key={stat.label} label={stat.label} value={stat.value} />
            ))}
          </View>
        ) : null}

        {/* The one thing to do leads on its own line; the things to do with
            it share the next. Four pills in a flow wrap left the last one
            orphaned on a row of its own. */}
        <View style={{ gap: 10 }}>
          {primaryAction ? (
            <DetailActionButton
              grow
              label={primaryAction.label}
              icon={<Repeat2 size={appTheme.icon.compact} color={appTheme.colors.textInverse} />}
              primary
              loading={remixLoading}
              onPress={() => void onRecreate(item)}
            />
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <DetailActionButton
              disabled={!item.canSave}
              grow
              label={item.isSaved ? 'Saved' : 'Save'}
              icon={<SaveHeart saved={item.isSaved} size={appTheme.icon.compact} enabled={item.canSave} />}
              loading={saveLoading}
              onPress={() => onSave(item)}
            />
            <DetailActionButton
              disabled={!item.canShare}
              grow
              label="Share"
              icon={<ShareGlyph size={appTheme.icon.compact} color={appTheme.colors.text} />}
              onPress={() => void onShare(item)}
            />
            {onComments && item.canComment ? (
              <DetailActionButton
                accessibilityLabel="Comments"
                grow
                label={commentCount > 0 ? formatCompactCount(commentCount) : 'Comment'}
                icon={<MessageCircle size={appTheme.icon.compact} color={appTheme.colors.text} />}
                onPress={onComments}
              />
            ) : null}
          </View>
        </View>

        <DetailSection title="Prompt">
          {details.prompt ? (
            <ResourcePrompt text={details.prompt} onCopy={copyText} />
          ) : null}
        </DetailSection>

        <DetailSection title="Caption">
          {captionText ? (
            <CopyableText text={captionText} onCopy={copyText} />
          ) : null}
        </DetailSection>

        {/* Most posts carry no unlock. A card announcing that absence is the
            page telling the reader about something that is not there. */}
        {unlock && sectionState !== 'none' ? (
          sectionState === 'unlocked' ? (
            <View style={{ gap: 12 }}>
              <ResourcesHeading
                pills={[
                  { label: 'Unlocked', accent: 'workflow' },
                  ...(prepared?.hasRemixAccess ? [{ label: 'Remix included', accent: 'primary' as ToolAccent }] : []),
                ]}
              />
              {prepared && !prepared.isEmpty ? (
                <PostResourceBundleContent
                  fileLoadingPath={fileLoadingPath}
                  mediaItems={item.mediaItems}
                  onCopy={copyText}
                  onError={setResourceError}
                  onOpenFile={openResourceFile}
                  onOpenUrl={openResourceUrl}
                  resolveFileUrl={resolveResourceFileUrl}
                  resources={prepared.resources}
                />
              ) : null}
              {resourceError ? <ErrorText message={resourceError} /> : null}
            </View>
          ) : (
            <View style={{ borderRadius: appTheme.radii.xl, borderCurve: 'continuous', borderWidth: 1, borderColor: `${accentColor(unlockAccent)}55`, backgroundColor: appTheme.colors.surface, padding: appTheme.spacing.card, gap: appTheme.spacing.gap }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                <View style={{ flex: 1, gap: 5 }}>
                  <Text style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>Creator's resources</Text>
                  <Text style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
                    {bundle?.previewText ?? unlock.previewText ?? 'The prompt, files and notes behind this result.'}
                  </Text>
                </View>
                {unlockPriceLabel ? <Pill label={unlockPriceLabel} accent={unlockAccent} /> : null}
              </View>
              <ResourceKindRow kinds={resourceKinds} />
              {sectionState === 'loading' ? (
                <ActivityIndicator color={appTheme.colors.primary} />
              ) : sectionState === 'error' ? (
                <View style={{ gap: 10 }}>
                  <ErrorText message={resourceQuery.error instanceof Error ? resourceQuery.error.message : 'Could not load these resources.'} />
                  <DetailActionButton label="Try again" icon={<FileText size={appTheme.icon.compact} color={appTheme.colors.text} />} onPress={() => void resourceQuery.refetch()} />
                </View>
              ) : (
                <>
                  <PostResourceBundleContent
                    lockedPreview={bundle?.lockedPreview}
                    mediaItems={item.mediaItems}
                    resources={null}
                  />
                  <View style={{ gap: 10 }}>
                    <DetailActionButton
                      label={!user ? 'Sign in to unlock' : unlock.accessMode === 'free' ? 'Get resources — Free' : 'Unlock with credits'}
                      icon={<Lock size={appTheme.icon.compact} color={appTheme.colors.textInverse} />}
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
                    {unlockError ? <ErrorText message={unlockError} /> : null}
                  </View>
                </>
              )}
            </View>
          )
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * The page's own chrome. Back here returns to the media (or the post), never
 * out of the screen — that is the host's arrow, which steps aside while this
 * page is showing. Opaque, so content scrolling under it stays legible.
 */
function DetailsHeader({
  backLabel,
  onActionsOpen,
  onBack,
  title,
  topInset,
}: {
  backLabel: string;
  onActionsOpen?: () => void;
  onBack?: () => void;
  title: string;
  topInset: number;
}) {
  return (
    <View
      style={{
        paddingTop: topInset + 4,
        paddingBottom: 6,
        paddingHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: appTheme.colors.app,
      }}
    >
      {onBack ? (
        <HeaderButton accessibilityLabel={backLabel} onPress={onBack}>
          <BackGlyph size={appTheme.icon.feature} color={appTheme.colors.text} />
        </HeaderButton>
      ) : (
        <View style={{ width: 48, height: 48 }} />
      )}
      <Text numberOfLines={1} style={{ flex: 1, textAlign: 'center', color: appTheme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>
        {title}
      </Text>
      {onActionsOpen ? (
        <HeaderButton accessibilityLabel="More options" onPress={onActionsOpen}>
          <MoreVertical size={appTheme.icon.feature} color={appTheme.colors.text} />
        </HeaderButton>
      ) : (
        <View style={{ width: 48, height: 48 }} />
      )}
    </View>
  );
}

function HeaderButton({ accessibilityLabel, children, onPress }: { accessibilityLabel: string; children: React.ReactNode; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: appTheme.colors.surfaceStrong,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

function ResourcesHeading({ pills }: { pills: Array<{ label: string; accent: ToolAccent }> }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>
        Creator's resources
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        {pills.map((pill) => <Pill key={pill.label} label={pill.label} accent={pill.accent} />)}
      </View>
    </View>
  );
}

function ErrorText({ message }: { message: string }) {
  return (
    <Text selectable style={{ color: appTheme.semantic.danger.foreground, ...appTheme.type.label }}>
      {message}
    </Text>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 148, borderRadius: appTheme.radii.md, borderCurve: 'continuous', backgroundColor: appTheme.colors.surfaceStrong, padding: appTheme.spacing.gap, gap: 4 }}>
      <Text numberOfLines={1} style={{ color: appTheme.colors.muted, ...appTheme.type.caption, textTransform: 'uppercase' }}>{label}</Text>
      <Text numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  );
}

/**
 * A section only exists when it has something to say. A heading over
 * "No prompt provided" is a label for an absence — it costs a line of the
 * reader's attention to tell them nothing.
 */
function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  if (!children) return null;

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>{title}</Text>
      {children}
    </View>
  );
}

function normalizeComparable(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function CopyableText({ text, onCopy }: { text: string; onCopy: (text: string) => Promise<void> }) {
  return (
    <View style={{ borderRadius: appTheme.radii.md, borderCurve: 'continuous', backgroundColor: appTheme.colors.surface, padding: appTheme.spacing.gap, gap: appTheme.spacing.gap }}>
      <Text selectable style={{ color: appTheme.colors.textSecondary, ...appTheme.type.bodySm }}>{text}</Text>
      <View style={{ flexDirection: 'row' }}>
        <ResourceAction
          confirmLabel="Copied"
          icon={<Copy size={appTheme.icon.xs} color={appTheme.colors.success} />}
          label="Copy"
          onPress={() => onCopy(text)}
        />
      </View>
    </View>
  );
}

function DetailActionButton({
  accessibilityLabel,
  disabled,
  grow,
  icon,
  label,
  loading,
  onPress,
  primary,
}: {
  accessibilityLabel?: string;
  disabled?: boolean;
  /** Share the row equally with its siblings instead of hugging the label. */
  grow?: boolean;
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
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: appTheme.touch.compact,
        flex: grow ? 1 : undefined,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 22,
        backgroundColor: primary ? primaryColor : appTheme.colors.surfaceStrong,
        opacity: disabled ? 0.45 : pressed ? appTheme.opacity.pressed : 1,
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
          <FileText size={appTheme.icon.xs} color={appTheme.colors.textSecondary} />
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
