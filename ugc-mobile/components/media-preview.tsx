import { Image, type ImageProps } from 'expo-image';
import { RecoverableVideoPreview } from '@/components/recoverable-video-preview';
import { ImageOff } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { imageRetryDelayMs } from '@/lib/media-performance';
import { useMediaSource } from '@/lib/use-media-source';
import { appTheme } from '@/lib/theme';

export function MediaPreview({
  url,
  kind,
  height,
  radius = appTheme.radii.lg,
  nativeControls = true,
}: {
  url: string | null | undefined;
  kind?: 'image' | 'video' | null;
  height?: number;
  radius?: number;
  nativeControls?: boolean;
}) {
  const { requestKey } = useMediaSource(url || '');
  const sourceKey = `${url}|${requestKey}`;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const imageFailed = failedUrl === sourceKey;

  if (!url) {
    return <MediaFallback height={height} radius={radius} label="No media" />;
  }

  if (kind === 'video') {
    return <VideoPreview url={url} height={height} radius={radius} nativeControls={nativeControls} />;
  }

  if (imageFailed) {
    return (
      <MediaFallback
        height={height}
        radius={radius}
        label="Preview unavailable"
        onRetry={() => {
          setFailedUrl(null);
          setRetryNonce((nonce) => nonce + 1);
        }}
      />
    );
  }

  return (
    <StableMediaImage
      key={`${url}:${retryNonce}`}
      url={url}
      cacheKey={url}
      contentFit="cover"
      onError={() => setFailedUrl(sourceKey)}
      style={{
        width: '100%',
        aspectRatio: 4 / 5,
        height,
        borderRadius: radius,
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        // A neutral tile rather than near-black: while a large preview loads,
        // #050506 is indistinguishable from the page behind it, so the card
        // reads as a hole punched in the layout instead of media on its way.
        backgroundColor: appTheme.colors.panelSoft,
      }}
    />
  );
}

type StableMediaImageProps = {
  url: string;
  cacheKey: string;
  thumbhash?: string | null;
  contentFit?: ImageProps['contentFit'];
  onDisplay?: ImageProps['onDisplay'];
  onLoad?: ImageProps['onLoad'];
  onError?: ImageProps['onError'];
  style?: ImageProps['style'];
  transition?: number;
  resolveRetryUrl?: () => Promise<string>;
};

export function StableMediaImage(props: StableMediaImageProps) {
  // A new source ends any pending renewal for the previously selected image.
  return <StableMediaImageSession key={`${props.cacheKey}|${props.url}`} {...props} />;
}

function StableMediaImageSession({
  url: initialUrl,
  cacheKey,
  thumbhash,
  contentFit = 'cover',
  onDisplay,
  onLoad,
  onError,
  style,
  transition = 120,
  resolveRetryUrl,
}: StableMediaImageProps) {
  const [url, setUrl] = useState(initialUrl);
  const [renewing, setRenewing] = useState(false);
  const [renewalFailed, setRenewalFailed] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  // Failure is keyed to the (cacheKey, url) pair, not cacheKey alone: parents
  // like ShowcaseMediaSlide keep the cacheKey stable while swapping the url to
  // a fallback source, and that swap must release the latch so the fallback
  // actually gets attempted. Comparing against the current props (rather than
  // a boolean) keeps recycled list instances from leaking one item's failure
  // onto another.
  const { source, requestKey } = useMediaSource(url);
  const sourceId = `${cacheKey}|${url}|${requestKey}`;
  const [failedSourceId, setFailedSourceId] = useState<string | null>(null);
  const [retry, setRetry] = useState({ sourceId, attempt: 0 });
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = retry.sourceId === sourceId ? retry.attempt : 0;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  const retryImage = async () => {
    if (pending.current) return;
    if (!resolveRetryUrl) {
      setFailedSourceId(null);
      setRetry({ sourceId, attempt: 0 });
      return;
    }
    pending.current = true;
    setRenewing(true);
    setRenewalFailed(false);
    try {
      const renewedUrl = await resolveRetryUrl();
      if (!renewedUrl.trim()) throw new Error('Missing renewed URL');
      if (mounted.current) {
        setUrl(renewedUrl);
        setFailedSourceId(null);
        setRetry({ sourceId, attempt: 0 });
      }
    } catch {
      if (mounted.current) setRenewalFailed(true);
    } finally {
      pending.current = false;
      if (mounted.current) setRenewing(false);
    }
  };

  if (failedSourceId === sourceId) {
    return (
      <MediaFallback
        radius={0}
        label={renewalFailed ? 'Couldn’t refresh image. Try again.' : 'Preview unavailable'}
        thumbhash={thumbhash}
        renewing={renewing}
        onRetry={() => void retryImage()}
      />
    );
  }

  return (
    <Image
      key={`${cacheKey}:${attempt}:${requestKey}`}
      source={{ ...source, cacheKey }}
      placeholder={thumbhash ? { thumbhash } : undefined}
      placeholderContentFit={contentFit}
      contentFit={contentFit}
      cachePolicy="memory-disk"
      recyclingKey={cacheKey}
      transition={transition}
      onDisplay={onDisplay}
      onLoad={onLoad}
      onError={(event) => {
        const delayMs = imageRetryDelayMs(attempt);
        if (delayMs === null) {
          setFailedSourceId(sourceId);
          onError?.(event);
          return;
        }
        if (retryTimer.current) clearTimeout(retryTimer.current);
        // A stale fire after this instance is recycled to another item is
        // harmless: `attempt` is derived by comparing retry.sourceId to the
        // current props, so a mismatched sourceId reads as attempt 0.
        retryTimer.current = setTimeout(() => {
          setRetry({ sourceId, attempt: attempt + 1 });
        }, delayMs);
      }}
      pointerEvents="none"
      style={style}
    />
  );
}

function MediaFallback({
  height,
  radius,
  label,
  thumbhash,
  onRetry,
  renewing = false,
}: {
  height?: number;
  radius: number;
  label: string;
  thumbhash?: string | null;
  onRetry?: () => void;
  renewing?: boolean;
}) {
  const frameStyle = {
    width: '100%' as const,
    aspectRatio: 4 / 5,
    height,
    borderRadius: radius,
    borderWidth: 1,
    borderColor: appTheme.colors.border,
    backgroundColor: appTheme.colors.surfaceInset,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 8,
    overflow: 'hidden' as const,
  };

  const content = (
    <>
      {thumbhash ? (
        <>
          <Image
            placeholder={{ thumbhash }}
            placeholderContentFit="cover"
            contentFit="cover"
            pointerEvents="none"
            style={{ position: 'absolute', inset: 0 }}
          />
          <View pointerEvents="none" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(3,3,6,0.55)' }} />
        </>
      ) : null}
      <ImageOff size={28} color={appTheme.colors.faint} />
      <Text style={{ color: appTheme.colors.textSecondary, fontSize: 12, fontWeight: '800' }}>{label}</Text>
      {onRetry ? (
        <Text style={{ color: appTheme.colors.faint, fontSize: 11, fontWeight: '700' }}>{renewing ? 'Refreshing image…' : 'Tap to retry'}</Text>
      ) : null}
    </>
  );

  if (!onRetry) {
    return <View style={frameStyle}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Retry loading media"
      accessibilityState={{ disabled: renewing, busy: renewing }}
      disabled={renewing}
      onPress={onRetry}
      style={({ pressed }) => [frameStyle, { opacity: pressed ? appTheme.opacity.pressed : 1 }]}
    >
      {content}
    </Pressable>
  );
}

function VideoPreview({
  url,
  height,
  radius,
  nativeControls,
}: {
  url: string;
  height?: number;
  radius: number;
  nativeControls: boolean;
}) {
  return (
    <RecoverableVideoPreview
      url={url}
      nativeControls={nativeControls}
      style={{
        width: '100%',
        aspectRatio: 4 / 5,
        height,
        borderRadius: radius,
        backgroundColor: '#050506',
      }}
    />
  );
}
