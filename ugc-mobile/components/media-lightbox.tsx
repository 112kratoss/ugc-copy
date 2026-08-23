import { useVideoPlayer, VideoView } from 'expo-video';
import { ChevronLeft, ChevronRight, X } from 'lucide-react-native';
import { Modal, Pressable, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StableMediaImage } from '@/components/media-preview';
import { AppText } from '@/components/ui';
import { appTheme } from '@/lib/theme';

export interface LightboxMediaItem {
  id: string;
  url: string;
  mediaKind: 'image' | 'video';
  /** The heading over the stage — a file name, a handle, a slot label. */
  label: string;
  /** A second, quieter line under the heading. */
  caption?: string | null;
}

/**
 * One piece of media, full screen, in the app.
 *
 * Anything the app can show it shows here rather than handing the reader to
 * a browser tab: an image sits on a contained stage, a video plays with native
 * controls, and neighbours are a tap away. The composer and the post's
 * reference media share this one surface.
 */
export function MediaLightbox({
  items,
  activeIndex,
  onClose,
  onNavigate,
}: {
  items: LightboxMediaItem[];
  activeIndex: number | null;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const isOpen = activeIndex !== null && activeIndex >= 0 && activeIndex < items.length;

  return (
    <Modal
      visible={isOpen}
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      onRequestClose={onClose}
    >
      {isOpen ? (
        <MediaLightboxContent
          items={items}
          activeIndex={activeIndex}
          onClose={onClose}
          onNavigate={onNavigate}
        />
      ) : null}
    </Modal>
  );
}

function MediaLightboxContent({
  items,
  activeIndex,
  onClose,
  onNavigate,
}: {
  items: LightboxMediaItem[];
  activeIndex: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const item = items[activeIndex];
  const hasPrevious = activeIndex > 0;
  const hasNext = activeIndex < items.length - 1;
  const counter = items.length > 1 ? `${activeIndex + 1} of ${items.length}` : '';
  const caption = [counter, item.caption?.trim()].filter(Boolean).join(' · ');

  // Leaves room for the header row and the safe-area chrome above and below.
  const stageHeight = Math.max(220, height - insets.top - insets.bottom - 150);

  return (
    // Opaque, not the usual translucent overlay: the web lightbox leans on a
    // backdrop blur to keep the page from reading through, and there is no blur
    // here — at 90% the headings underneath show straight through this heading.
    <View style={{ flex: 1, backgroundColor: '#08080a' }}>
      <Pressable
        accessible={false}
        onPress={onClose}
        style={{ position: 'absolute', inset: 0 }}
      />
      <View
        accessibilityViewIsModal
        style={{
          flex: 1,
          paddingTop: insets.top + 10,
          paddingBottom: insets.bottom + 10,
          paddingHorizontal: 14,
          gap: 12,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <AppText variant="label" numberOfLines={1}>{item.label}</AppText>
            {caption ? (
              <AppText variant="caption" color="muted" numberOfLines={1}>
                {caption}
              </AppText>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close media preview"
            hitSlop={10}
            onPress={onClose}
            style={({ pressed }) => ({
              width: 38,
              height: 38,
              borderRadius: 19,
              borderWidth: 1,
              borderColor: appTheme.colors.border,
              backgroundColor: pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surface,
              alignItems: 'center',
              justifyContent: 'center',
            })}
          >
            <X size={18} color={appTheme.colors.text} strokeWidth={2.6} />
          </Pressable>
        </View>

        <View
          style={{
            height: stageHeight,
            borderRadius: 20,
            borderWidth: 1,
            borderColor: appTheme.colors.border,
            backgroundColor: '#050506',
            overflow: 'hidden',
            justifyContent: 'center',
          }}
        >
          {item.mediaKind === 'video' ? (
            <LightboxVideo key={item.id} url={item.url} height={stageHeight} />
          ) : (
            <StableMediaImage
              key={item.id}
              url={item.url}
              cacheKey={`lightbox:${item.id}`}
              contentFit="contain"
              style={{ width: '100%', height: stageHeight }}
            />
          )}

          {hasPrevious ? (
            <LightboxArrow
              side="left"
              label="Show previous media"
              onPress={() => onNavigate(activeIndex - 1)}
            />
          ) : null}
          {hasNext ? (
            <LightboxArrow
              side="right"
              label="Show next media"
              onPress={() => onNavigate(activeIndex + 1)}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
}

function LightboxVideo({ url, height }: { url: string; height: number }) {
  const player = useVideoPlayer(url, (instance) => {
    instance.loop = true;
    instance.muted = false;
    instance.play();
  });

  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      style={{ width: '100%', height, backgroundColor: '#050506' }}
    />
  );
}

function LightboxArrow({
  side,
  label,
  onPress,
}: {
  side: 'left' | 'right';
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={10}
      onPress={onPress}
      style={({ pressed }) => ({
        position: 'absolute',
        top: '50%',
        marginTop: -22,
        [side]: 12,
        width: 44,
        height: 44,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: pressed ? appTheme.colors.surfaceStrong : 'rgba(0,0,0,0.65)',
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      {side === 'left' ? (
        <ChevronLeft size={22} color="#fff" strokeWidth={2.6} />
      ) : (
        <ChevronRight size={22} color="#fff" strokeWidth={2.6} />
      )}
    </Pressable>
  );
}
