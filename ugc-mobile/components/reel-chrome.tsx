import { Image } from 'expo-image';
import { FileText, Globe, Heart, Images, LockKeyhole, MessageCircle, MoreHorizontal, Repeat2, Wand2 } from 'lucide-react-native';
import { cloneElement, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, Text, View } from 'react-native';

import { verticalHitSlop } from '@/lib/hit-target';
import { formatCompactCount } from '@/lib/home-view-model';
import { hasImmersiveDetailsPage, type ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { useReducedMotion } from '@/lib/motion';
import { ShareGlyph } from '@/lib/platform-glyphs';
import { buildReelCaption, getRailCountLabel } from '@/lib/reel-overlay-view-model';
import { appTheme, type AppTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import {
  getRailActionOpacity,
  getSaveHeartIconProps,
  getSaveHeartTapAnimationSpec,
  getViewerActionSlots,
  getViewerStateChip,
  type SaveHeartTapAnimationSpec,
  type ViewerStateTone,
} from '@/lib/viewer-actions';
import { viewerTopBadgeTop } from '@/lib/viewer-chrome';
import { renderReelIcon } from '@/components/reel-icon';

/**
 * A reel slide's chrome — the right rail, the creator and caption block, the
 * media counter and the scrim behind the text — as one component, drawn in two
 * places: over the slide in the reel (`app/viewer.tsx`), and inside the window
 * a post grows in out of its tile (`components/media-zoom.tsx`), so that the
 * reader sees the whole post from the first frame of that growth rather than a
 * bare picture that is dressed once it lands. Both draw the same layout from the
 * same item, so the one hands over to the other without a pixel changing.
 */

/** The creator byline reads as a single line of text; its reach is widened rather than its height. */
const CREATOR_ROW_HEIGHT = 34;

/**
 * The shade behind the caption and the rail, as React Native's own gradient,
 * which on iOS is a CAGradientLayer that the render server draws.
 * expo-linear-gradient painted each shade into a bitmap on the main thread
 * whenever its view appeared or changed size, and a reel opening does both:
 * the slide and its neighbours mount their shades, each grows to its caption
 * once that is measured, and the top shade and any letterbox bands come too.
 * On the iPhone 16e that was 16–27 ms of painting at every open and every
 * swipe, more than a 60 Hz frame. On Android both draw through a shader, with
 * the same pixels.
 */
const CAPTION_SCRIM = 'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.42) 42%, rgba(0,0,0,0.84) 100%)';

export const REEL_TEXT_SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.55)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 5,
} as const;

export interface ReelSlideChromeProps {
  item: ImmersivePreviewItem;
  topInset: number;
  bottomInset: number;
  /** The media page under the finger, for the counter. */
  pageIndex: number;
  /** The creator's Follow pill, when it shows at all. */
  follow: { following: boolean; pending: boolean; onPress: () => void } | null;
  captionExpanded: boolean;
  onToggleCaption: () => void;
  saveLoading: boolean;
  /** Bumped by a double-tap save, so the rail's heart pops with it. */
  saveHeartPopTrigger?: number;
  remixLoading: boolean;
  ownerActionPending?: string | null;
  onSave: (item: ImmersivePreviewItem) => void;
  /** Absent where the post takes no comments: the rail then draws no bubble. */
  onComments?: () => void;
  onShare: (item: ImmersivePreviewItem) => void;
  onOpenDetails: () => void;
  onUnlockRemix: (item: ImmersivePreviewItem) => void;
  onRecreate: (item: ImmersivePreviewItem) => void;
  onOwnerAction?: (action: string) => void;
  onActionsOpen: () => void;
  onCreatorOpen: (item: ImmersivePreviewItem) => void;
}

export function ReelSlideChrome({
  item,
  topInset,
  bottomInset,
  pageIndex,
  follow,
  captionExpanded,
  onToggleCaption,
  saveLoading,
  saveHeartPopTrigger,
  remixLoading,
  ownerActionPending,
  onSave,
  onComments,
  onShare,
  onOpenDetails,
  onUnlockRemix,
  onRecreate,
  onOwnerAction,
  onActionsOpen,
  onCreatorOpen,
}: ReelSlideChromeProps) {
  const theme = useAppTheme();
  // The bottom scrim is sized to the text it protects, so it is measured.
  const [captionBlockHeight, setCaptionBlockHeight] = useState(0);
  const reelCaption = useMemo(() => buildReelCaption(item), [item]);
  const railSlots = useMemo(() => getViewerActionSlots(item), [item]);
  const stateChip = useMemo(() => getViewerStateChip(item), [item]);
  const mediaCount = item.mediaItems?.length ?? 0;
  const isTextPost = item.previewKind === 'text';
  const canOpenCreator = Boolean(item.creatorUsername);

  // Only the text needs a scrim. It runs from just above the caption block
  // to the bottom edge and no further — the picture above it is the point.
  const scrimHeight = Math.max(220, captionBlockHeight + bottomInset + 120);

  return (
    <>
      <View
        pointerEvents="none"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: scrimHeight, experimental_backgroundImage: CAPTION_SCRIM }}
      />

      {/* Media count indicator. The trailing half of the viewer's badge row —
          the leading half is the reel's refresh spinner, and both are placed
          from the safe-area inset by `lib/viewer-chrome` so they cannot be
          drawn over each other again. */}
      {!isTextPost && mediaCount > 1 ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            right: 18,
            top: viewerTopBadgeTop(topInset),
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.14)',
            backgroundColor: 'rgba(3,3,6,0.68)',
            paddingHorizontal: 10,
            // `caption` carries a 17pt line box against the 11pt raw size this
            // chip used to set, so the padding comes down to keep the pill the
            // height it was — same trade S5 made on the feed's counter.
            paddingVertical: 3,
          }}
        >
          <Images size={appTheme.icon.xs} color="#ffffff" />
          <Text style={{ color: '#ffffff', ...appTheme.type.caption, fontWeight: '800' }}>
            {Math.min(pageIndex + 1, mediaCount)} / {mediaCount}
          </Text>
        </View>
      ) : null}

      {/* Right rail. The universal actions are bare icons with a count for a
          label, the way every reel app draws them; only what is ours — Remix,
          Details, the owner's publish controls — keeps a button and a word. */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          right: 14,
          bottom: bottomInset + 96,
          alignItems: 'center',
          gap: 14,
        }}
      >
        {railSlots.map((slot) => {
          if (slot.id === 'save') {
            const saveCountLabel = getRailCountLabel(item.saveCount, formatCompactCount);
            return (
              <RailActionButton
                key={slot.id}
                accessibilityLabel={item.isSaved
                  ? 'Saved'
                  : saveCountLabel
                    ? `Save, ${item.saveCount} ${item.saveCount === 1 ? 'save' : 'saves'}`
                    : 'Save'}
                disabled={!item.canSave}
                icon={<Heart size={30} {...getSaveHeartIconProps({ isSaved: item.isSaved, enabled: item.canSave })} />}
                label={saveCountLabel}
                loading={saveLoading}
                onPress={() => onSave(item)}
                preserveIconWhileLoading
                showDisabledAsActive={item.isSaved && !item.canSave}
                tapAnimationSpec={getSaveHeartTapAnimationSpec({ willSave: !item.isSaved, enabled: item.canSave })}
                externalPopTrigger={saveHeartPopTrigger}
                variant="bare"
              />
            );
          }
          if (slot.id === 'comment') {
            return onComments ? (
              <RailActionButton
                key={slot.id}
                accessibilityLabel={item.commentCount > 0
                  ? `${item.commentCount} ${item.commentCount === 1 ? 'comment' : 'comments'}`
                  : 'Comment'}
                icon={<MessageCircle size={30} color="#ffffff" fill="transparent" />}
                iconShadow={false}
                label={getRailCountLabel(item.commentCount, formatCompactCount)}
                onPress={onComments}
                variant="bare"
              />
            ) : null;
          }
          if (slot.id === 'share') {
            return (
              <RailActionButton
                key={slot.id}
                accessibilityLabel="Share"
                icon={<ShareGlyph size={28} color="#ffffff" />}
                label={null}
                onPress={() => void onShare(item)}
                variant="bare"
              />
            );
          }
          if (slot.id === 'details') {
            return hasImmersiveDetailsPage(item) ? (
              <RailActionButton
                key={slot.id}
                icon={<FileText size={26} color="#ffffff" />}
                label={slot.label}
                onPress={onOpenDetails}
              />
            ) : null;
          }
          if (slot.id === 'create') {
            return (
              <RailActionButton
                key={slot.id}
                primary
                icon={<Repeat2 size={26} color="#050505" />}
                label={slot.label}
                loading={slot.action === 'unlock-remix' ? false : remixLoading}
                onPress={slot.action === 'unlock-remix' ? () => onUnlockRemix(item) : () => void onRecreate(item)}
              />
            );
          }

          // Ownership slots — publish, visibility, unlock — all delegate to the
          // same action ids the More sheet uses, so there is one code path per action.
          const ownerIcon = slot.id === 'publish'
            ? <Globe size={26} color="#050505" />
            : slot.id === 'unlock'
              ? <Wand2 size={26} color={theme.colors.success} />
              : (item.visibility ?? item.linkedPostVisibility) === 'private' || (item.visibility ?? item.linkedPostVisibility) === 'unlisted'
                ? <LockKeyhole size={26} color={theme.colors.warning} />
                : <Globe size={26} color="#ffffff" />;

          return (
            <RailActionButton
              key={slot.id}
              accessibilityLabel={slot.a11yLabel ?? slot.label}
              icon={ownerIcon}
              label={slot.label}
              loading={ownerActionPending === slot.action}
              primary={slot.tone === 'primary'}
              onPress={() => slot.action && onOwnerAction?.(slot.action)}
            />
          );
        })}
        <RailActionButton
          accessibilityLabel="More options"
          icon={<MoreHorizontal size={28} color="#ffffff" />}
          label={null}
          onPress={onActionsOpen}
          variant="bare"
        />
      </View>

      {/* Bottom text: who, then what — identity beside the caption, the way a
          reader expects to find it, with the whole block one tap from its
          full length. */}
      <View
        pointerEvents="box-none"
        onLayout={(event) => setCaptionBlockHeight(event.nativeEvent.layout.height)}
        style={{
          position: 'absolute',
          left: 18,
          right: 88,
          bottom: bottomInset + 24,
          gap: 8,
        }}
      >
        {/* A text slide already prints its own badge, title and body, so the
            overlay would say all three a second time. */}
        {isTextPost ? null : (
        <>
        <View pointerEvents="none" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          <View style={{ borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.16)', paddingHorizontal: 10, paddingVertical: 6 }}>
            <Text numberOfLines={1} style={{ color: '#fff', fontSize: 11, lineHeight: 13, fontWeight: '800' }}>
              {item.badge}
            </Text>
          </View>
          {/* Owned media leads with its publish state — for a creation that is the
              single most important fact on the slide. */}
          {stateChip ? (
            <View
              style={{
                borderRadius: 999,
                borderWidth: 1,
                borderColor: viewerStateChipStyle(stateChip.tone, theme.semantic).border,
                backgroundColor: viewerStateChipStyle(stateChip.tone, theme.semantic).background,
                paddingHorizontal: 10,
                paddingVertical: 6,
              }}
            >
              <Text numberOfLines={1} style={{ color: viewerStateChipStyle(stateChip.tone, theme.semantic).foreground, fontSize: 11, lineHeight: 13, fontWeight: '800' }}>
                {stateChip.label}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.creatorLabel} profile`}
            disabled={!canOpenCreator}
            onPress={() => onCreatorOpen(item)}
            hitSlop={verticalHitSlop(CREATOR_ROW_HEIGHT)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 9,
              flexShrink: 1,
              minHeight: CREATOR_ROW_HEIGHT,
              opacity: pressed ? appTheme.opacity.pressed : canOpenCreator ? 1 : 0.86,
            })}
          >
            <ViewerCreatorAvatar item={item} size={34} />
            <Text numberOfLines={1} style={{ flexShrink: 1, color: '#fff', fontSize: 15, lineHeight: 19, fontWeight: '700', ...REEL_TEXT_SHADOW }}>
              {item.creatorLabel}
            </Text>
          </Pressable>
          {follow ? (
            <FollowPill
              following={follow.following}
              pending={follow.pending}
              onPress={follow.onPress}
            />
          ) : null}
        </View>
        {reelCaption.title || reelCaption.caption ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={captionExpanded ? 'Collapse caption' : 'Expand caption'}
            onPress={onToggleCaption}
            style={({ pressed }) => ({ gap: 3, opacity: pressed ? appTheme.opacity.pressed : 1 })}
          >
            {reelCaption.title ? (
              <Text numberOfLines={captionExpanded ? 4 : 1} style={{ color: '#fff', fontSize: 16, lineHeight: 21, fontWeight: '700', ...REEL_TEXT_SHADOW }}>
                {reelCaption.title}
              </Text>
            ) : null}
            {reelCaption.caption ? (
              <Text numberOfLines={captionExpanded ? 8 : 1} style={{ color: 'rgba(255,255,255,0.88)', fontSize: 14, lineHeight: 19, fontWeight: '400', ...REEL_TEXT_SHADOW }}>
                {reelCaption.caption}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
        </>
        )}
      </View>
    </>
  );
}

function viewerStateChipStyle(tone: ViewerStateTone, tones: AppTheme['semantic']) {
  const semantic = tone === 'neutral' ? tones.neutral : tones[tone];
  return {
    foreground: semantic.foreground,
    // The semantic tints are tuned for app surfaces and wash out over media, so the
    // chip keeps a dark fill and lets the semantic border carry the signal.
    background: 'rgba(8,8,10,0.62)',
    border: semantic.border,
  };
}

function ViewerCreatorAvatar({
  item,
  onPress,
  size = 40,
}: {
  item: ImmersivePreviewItem;
  onPress?: () => void;
  size?: number;
}) {
  const initial = item.creatorLabel.replace(/^@/, '').trim()[0]?.toUpperCase() || 'C';
  const innerSize = size - 3;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.creatorLabel} profile`}
      disabled={!onPress}
      onPress={onPress}
      hitSlop={Math.max(0, (appTheme.touch.compact - size) / 2)}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        padding: 1.5,
        backgroundColor: 'rgba(255,255,255,0.9)',
        opacity: pressed ? appTheme.opacity.pressed : onPress ? 1 : 0.9,
      })}
    >
      <View style={{ flex: 1, overflow: 'hidden', borderRadius: innerSize / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: '#27272a' }}>
        {item.creatorAvatar ? (
          <Image source={{ uri: item.creatorAvatar }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
        ) : (
          <Text style={{ color: '#fff', fontSize: size > 44 ? 20 : 15, fontWeight: '800' }}>{initial}</Text>
        )}
      </View>
    </Pressable>
  );
}

type ShadowableIconProps = { color?: string; fill?: string; strokeWidth?: number };

/**
 * A bare icon over a photograph needs an edge. Native shadows cannot follow a
 * glyph on Android, so the icon is drawn twice: a darker, slightly thicker
 * copy a pixel below, then the icon itself — a soft halo that reads over
 * both a pale sky and a black dress.
 */
export function IconShadow({ children }: { children: ReactElement<ShadowableIconProps> }) {
  const raster = renderReelIcon(children, true);
  if (raster) return raster;
  const hasFill = Boolean(children.props.fill) && children.props.fill !== 'none' && children.props.fill !== 'transparent';
  const shadow = cloneElement(children, {
    color: 'rgba(0,0,0,0.55)',
    fill: hasFill ? 'rgba(0,0,0,0.55)' : children.props.fill,
    strokeWidth: (children.props.strokeWidth ?? appTheme.icon.stroke) + 1.4,
  });

  return (
    <View>
      <View pointerEvents="none" style={{ position: 'absolute', top: 1.5, left: 0 }}>{shadow}</View>
      {children}
    </View>
  );
}

function FollowPill({ following, pending, onPress }: { following: boolean; pending: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={following ? 'Following' : 'Follow'}
      accessibilityState={{ selected: following, busy: pending }}
      disabled={pending}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 30,
        justifyContent: 'center',
        borderRadius: 999,
        borderWidth: 1.5,
        borderColor: following ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.92)',
        backgroundColor: 'rgba(0,0,0,0.18)',
        paddingHorizontal: 12,
        opacity: pending ? 0.6 : pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <Text style={{ color: following ? 'rgba(255,255,255,0.8)' : '#fff', fontSize: 13, lineHeight: 16, fontWeight: '700' }}>
        {following ? 'Following' : 'Follow'}
      </Text>
    </Pressable>
  );
}

function RailActionButton({
  accessibilityLabel: providedAccessibilityLabel,
  disabled,
  externalPopTrigger,
  icon,
  iconShadow = true,
  label,
  loading,
  onPress,
  primary,
  preserveIconWhileLoading,
  showDisabledAsActive,
  tapAnimationSpec,
  variant = 'circle',
}: {
  accessibilityLabel?: string;
  disabled?: boolean;
  externalPopTrigger?: number;
  icon: ReactElement<ShadowableIconProps>;
  /** Bare icons use the shared contrast halo unless a glyph should remain flat. */
  iconShadow?: boolean;
  /** Under the icon: a word for app-specific actions, a count for the rest, or nothing. */
  label: string | null;
  loading?: boolean;
  onPress: () => void;
  primary?: boolean;
  preserveIconWhileLoading?: boolean;
  showDisabledAsActive?: boolean;
  tapAnimationSpec?: SaveHeartTapAnimationSpec;
  /** `bare` draws the icon straight on the picture; `circle` gives it a button. */
  variant?: 'circle' | 'bare';
}) {
  const theme = useAppTheme();
  const tapProgress = useRef(new Animated.Value(0)).current;
  const externalPopProgress = useRef(new Animated.Value(0)).current;
  const previousExternalPopTriggerRef = useRef(externalPopTrigger);
  const reducedMotion = useReducedMotion();
  const [activeTapAnimationSpec, setActiveTapAnimationSpec] = useState(tapAnimationSpec);
  const animationSpec = activeTapAnimationSpec ?? tapAnimationSpec;
  const bare = variant === 'bare';
  const accessibilityLabel = providedAccessibilityLabel ?? label ?? 'Action';
  const iconScale = tapProgress.interpolate({
    inputRange: [0, 0.32, 0.66, 1],
    outputRange: [
      1,
      animationSpec?.pressInScale ?? 1,
      animationSpec?.peakScale ?? 1,
      1,
    ],
  });
  const haloOpacity = tapProgress.interpolate({
    inputRange: [0, 0.36, 1],
    outputRange: [0, animationSpec?.haloPeakOpacity ?? 0, 0],
  });
  const haloScale = tapProgress.interpolate({
    inputRange: [0, 0.44, 1],
    outputRange: [0.92, animationSpec?.haloPeakScale ?? 1, (animationSpec?.haloPeakScale ?? 1) + 0.04],
  });
  const externalIconScale = externalPopProgress.interpolate({
    inputRange: [0, 0.42, 1],
    outputRange: [1, 1.13, 1],
  });

  const runTapAnimation = useCallback(() => {
    if (!tapAnimationSpec || reducedMotion) {
      return;
    }

    setActiveTapAnimationSpec(tapAnimationSpec);
    tapProgress.stopAnimation();
    tapProgress.setValue(0);
    Animated.sequence([
      Animated.timing(tapProgress, {
        toValue: 0.32,
        duration: tapAnimationSpec.pressInDurationMs,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(tapProgress, {
        toValue: 1,
        duration: tapAnimationSpec.settleDurationMs,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [reducedMotion, tapAnimationSpec, tapProgress]);

  useEffect(() => {
    if (
      externalPopTrigger === undefined
      || externalPopTrigger === previousExternalPopTriggerRef.current
    ) {
      return;
    }

    previousExternalPopTriggerRef.current = externalPopTrigger;
    externalPopProgress.stopAnimation();
    externalPopProgress.setValue(0);
    if (reducedMotion) return;

    Animated.sequence([
      Animated.timing(externalPopProgress, {
        toValue: 0.42,
        duration: 80,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(externalPopProgress, {
        toValue: 1,
        duration: 150,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [externalPopProgress, externalPopTrigger, reducedMotion]);

  useEffect(() => () => {
    externalPopProgress.stopAnimation();
  }, [externalPopProgress]);

  const handlePress = useCallback(() => {
    runTapAnimation();
    onPress();
  }, [onPress, runTapAnimation]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled || loading), busy: Boolean(loading) }}
      disabled={disabled || loading}
      onPress={handlePress}
      style={({ pressed }) => ({
        alignItems: 'center',
        gap: 5,
        opacity: getRailActionOpacity({
          disabled: disabled || loading,
          pressed,
          showAsActive: showDisabledAsActive || (Boolean(loading) && Boolean(preserveIconWhileLoading)),
        }),
        minWidth: 64,
        // Without a ceiling a long label widens the button and drags the whole rail
        // out of its column, so labels truncate inside a fixed-width lane instead.
        maxWidth: 76,
      })}
    >
      <View
        style={{
          // The touch target keeps its size either way; only the button drawing
          // comes and goes with the variant.
          width: bare ? 48 : 54,
          height: bare ? 48 : 54,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 27,
          borderWidth: primary || bare ? 0 : 1,
          borderColor: 'rgba(255,255,255,0.16)',
          backgroundColor: bare ? 'transparent' : primary ? theme.colors.primaryFill : 'rgba(12,12,16,0.42)',
        }}
      >
        {tapAnimationSpec && animationSpec ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              width: 54,
              height: 54,
              borderRadius: 27,
              backgroundColor: animationSpec.haloColor,
              opacity: haloOpacity,
              transform: [{ scale: haloScale }],
            }}
          />
        ) : null}
        {loading && !preserveIconWhileLoading ? (
          <ActivityIndicator color={primary ? '#050505' : '#fff'} />
        ) : (
          <Animated.View style={{ transform: [{ scale: iconScale }] }}>
            <Animated.View style={{ transform: [{ scale: externalIconScale }] }}>
              {bare && iconShadow ? <IconShadow>{icon}</IconShadow> : (renderReelIcon(icon, false) ?? icon)}
            </Animated.View>
          </Animated.View>
        )}
      </View>
      {label ? (
        <Text
          numberOfLines={1}
          style={{
            color: '#fff',
            fontSize: 12,
            lineHeight: 15,
            fontWeight: bare ? '700' : '800',
            marginTop: bare ? -2 : 0,
            textShadowColor: 'rgba(0,0,0,0.6)',
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: 6,
            fontVariant: ['tabular-nums'],
          }}
        >
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}
