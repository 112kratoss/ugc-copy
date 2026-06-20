import { Image } from 'expo-image';
import { VideoView, type VideoPlayer } from 'expo-video';
import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { appTheme } from '@/lib/theme';
import { StableMediaImage } from '@/components/media-preview';

type FeedMediaFrameBaseProps = {
  backdropUrl?: string | null;
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
  transition?: number;
  url: string;
};

type FeedVideoFrameProps = FeedMediaFrameBaseProps & {
  kind: 'video';
  onFirstFrameRender?: () => void;
  player: VideoPlayer;
  posterUrl?: string | null;
  posterVisible?: boolean;
};

type FeedMediaFrameProps = FeedImageFrameProps | FeedVideoFrameProps;

const absoluteFill = {
  position: 'absolute' as const,
  inset: 0,
};

const videoViewProps = {
  allowsPictureInPicture: false,
  fullscreenOptions: { enable: false },
  nativeControls: false,
  startsPictureInPictureAutomatically: false,
  surfaceType: 'textureView' as const,
  useExoShutter: false,
};

export function FeedMediaFrame(props: FeedMediaFrameProps) {
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
                source={{ uri: props.backdropUrl || props.url }}
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
            cacheKey={props.cacheKey ?? (props.recyclingKey ? `${props.recyclingKey}:foreground` : props.url)}
            thumbhash={props.thumbhash}
            contentFit={props.imageContentFit ?? 'contain'}
            onError={props.onImageError}
            transition={props.transition}
            style={[absoluteFill, { backgroundColor: 'transparent' }]}
          />
        </>
      ) : (
        <>
          {props.backdropUrl ? (
            <Image
              source={{ uri: props.backdropUrl }}
              contentFit="cover"
              blurRadius={24}
              cachePolicy="memory-disk"
              priority="low"
              recyclingKey={props.recyclingKey ? `${props.recyclingKey}:video-backdrop` : undefined}
              pointerEvents="none"
              style={[absoluteFill, { backgroundColor }]}
            />
          ) : null}
          <View pointerEvents="none" style={[absoluteFill, { backgroundColor: 'rgba(0,0,0,0.44)' }]} />
          <VideoView
            {...videoViewProps}
            player={props.player}
            contentFit="contain"
            onFirstFrameRender={props.onFirstFrameRender}
            pointerEvents="none"
            style={[absoluteFill, { backgroundColor: 'transparent' }]}
          />
          {props.posterVisible && props.posterUrl ? (
            <StableMediaImage
              url={props.posterUrl}
              cacheKey={props.cacheKey ?? (props.recyclingKey ? `${props.recyclingKey}:video-poster` : props.posterUrl)}
              thumbhash={props.thumbhash}
              contentFit="contain"
              style={[absoluteFill, { backgroundColor: 'transparent' }]}
            />
          ) : null}
        </>
      )}
      {children}
    </View>
  );
}
