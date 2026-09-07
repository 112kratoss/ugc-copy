import { Image, type ImageProps } from 'expo-image';
import { VideoView, type VideoPlayer } from 'expo-video';
import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useMediaSource } from '@/lib/use-media-source';
import { appTheme } from '@/lib/theme';
import { StableMediaImage } from '@/components/media-preview';

type FeedMediaFrameBaseProps = {
  backdropUrl?: string | null;
  backdropCacheKey?: string;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  children?: ReactNode;
  priority?: 'low' | 'normal' | 'high';
  radius?: number;
  recyclingKey?: string;
  cacheKey?: string;
  thumbhash?: string | null;
  style?: StyleProp<ViewStyle>;
};

type FeedImageFrameProps = FeedMediaFrameBaseProps & {
  kind: 'image';
  imageBackdrop?: 'blurred' | 'none';
  imageContentFit?: 'cover' | 'contain';
  onImageError?: () => void;
  onImageLoad?: ImageProps['onLoad'];
  transition?: number;
  url: string;
};

type FeedVideoFrameProps = FeedMediaFrameBaseProps & {
  kind: 'video';
  onFirstFrameRender?: () => void;
  player: VideoPlayer;
  posterUrl?: string | null;
  posterVisible?: boolean;
  videoBackdrop?: 'blurred' | 'none';
  videoContentFit?: 'cover' | 'contain';
};

type FeedMediaFrameProps = FeedImageFrameProps | FeedVideoFrameProps;

const absoluteFill = {
  position: 'absolute' as const,
  inset: 0,
};

/**
 * Presentation for every feed-side `VideoView`, shared with FeedVideoPreview so
 * the two cannot drift. `useExoShutter: false` means ExoPlayer draws no black
 * shutter before the first frame — the caller's poster is the only cover, so a
 * consumer that drops its poster early will show the bare surface.
 */
export const FEED_VIDEO_VIEW_PROPS = {
  allowsPictureInPicture: false,
  fullscreenOptions: { enable: false },
  nativeControls: false,
  startsPictureInPictureAutomatically: false,
  surfaceType: 'textureView' as const,
  useExoShutter: false,
};

export function FeedMediaFrame(props: FeedMediaFrameProps) {
  const foregroundUrl = props.kind === 'image' ? props.url : props.posterUrl;
  const foregroundCacheKey = props.cacheKey ?? (props.recyclingKey
    ? `${props.recyclingKey}:${props.kind === 'image' ? 'foreground' : 'video-poster'}`
    : foregroundUrl);
  const backdropUrl = props.backdropUrl || (props.kind === 'image' ? props.url : '');
  const { source } = useMediaSource(backdropUrl);
  // Share bytes only when both layers represent the same asset. A separate
  // preview must never overwrite the full-size foreground's cache entry.
  const backdropCacheKey = props.backdropCacheKey
    ?? (backdropUrl === foregroundUrl ? foregroundCacheKey : undefined);
  const backdropSource = backdropCacheKey ? { ...source, cacheKey: backdropCacheKey } : source;
  const {
    backgroundColor = appTheme.colors.app,
    borderColor,
    borderWidth = borderColor ? 1 : 0,
    children,
    radius = 0,
    style,
  } = props;

  return (
    <View
      pointerEvents={props.kind === 'video' ? 'none' : undefined}
      style={[
        {
          overflow: 'hidden',
          borderRadius: radius,
          borderCurve: 'continuous',
          borderWidth,
          borderColor,
          backgroundColor,
        },
        style,
      ]}
    >
      {props.kind === 'image' ? (
        <>
          {(props.imageBackdrop ?? 'blurred') === 'blurred' ? (
            <>
              <Image
                source={backdropSource}
                contentFit="cover"
                blurRadius={24}
                cachePolicy="memory-disk"
                priority="low"
                recyclingKey={props.recyclingKey ? `${props.recyclingKey}:backdrop` : undefined}
                pointerEvents="none"
                style={[absoluteFill, { backgroundColor }]}
              />
              <View pointerEvents="none" style={[absoluteFill, { backgroundColor: 'rgba(0,0,0,0.34)' }]} />
            </>
          ) : null}
          <StableMediaImage
            url={props.url}
            cacheKey={foregroundCacheKey ?? props.url}
            thumbhash={props.thumbhash}
            contentFit={props.imageContentFit ?? 'contain'}
            onError={props.onImageError}
            onLoad={props.onImageLoad}
            transition={props.transition}
            style={[absoluteFill, { backgroundColor: 'transparent' }]}
          />
        </>
      ) : (
        <>
          {props.backdropUrl && (props.videoBackdrop ?? 'blurred') === 'blurred' ? (
            <Image
              source={backdropSource}
              contentFit="cover"
              blurRadius={24}
              cachePolicy="memory-disk"
              priority="low"
              recyclingKey={props.recyclingKey ? `${props.recyclingKey}:video-backdrop` : undefined}
              pointerEvents="none"
              style={[absoluteFill, { backgroundColor }]}
            />
          ) : null}
          {(props.videoBackdrop ?? 'blurred') === 'blurred' ? (
            <View pointerEvents="none" style={[absoluteFill, { backgroundColor: 'rgba(0,0,0,0.44)' }]} />
          ) : null}
          <VideoView
            {...FEED_VIDEO_VIEW_PROPS}
            player={props.player}
            contentFit={props.videoContentFit ?? 'contain'}
            onFirstFrameRender={props.onFirstFrameRender}
            pointerEvents="none"
            style={[absoluteFill, { backgroundColor: 'transparent' }]}
          />
          {props.posterVisible && props.posterUrl ? (
            <StableMediaImage
              url={props.posterUrl}
              cacheKey={foregroundCacheKey ?? props.posterUrl}
              thumbhash={props.thumbhash}
              contentFit={props.videoContentFit ?? 'contain'}
              style={[absoluteFill, { backgroundColor: 'transparent' }]}
            />
          ) : null}
        </>
      )}
      {children}
    </View>
  );
}
