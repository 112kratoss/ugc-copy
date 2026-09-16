import { Image, type ImageProps } from 'expo-image';
import { RecoverableVideoPreview } from '@/components/recoverable-video-preview';
import { ImageOff } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { useAppForeground } from '@/lib/app-foreground';
import { describeImageError, recordMediaDiagnostic } from '@/lib/media-diagnostics';
import { imageRetryDelayMs } from '@/lib/media-performance';
import {
  MEDIA_DISPLAY_DEADLINE_MS,
  MEDIA_RECOVERY_WAIT_MS,
  MEDIA_RECOVERY_MAX_WAIT_MS,
  classifyImageStall,
  mediaRecoveryBudget,
  type MediaRecoverySlot,
} from '@/lib/media-recovery';
import { useMediaSource } from '@/lib/use-media-source';
import { appTheme } from '@/lib/theme';

export function MediaPreview({
  url,
  kind,
  height,
  radius = appTheme.radii.lg,
  nativeControls = true,
  resolveRetryUrl,
}: {
  url: string | null | undefined;
  kind?: 'image' | 'video' | null;
  height?: number;
  radius?: number;
  nativeControls?: boolean;
  /** A fresh link for a video whose own has stopped working. */
  resolveRetryUrl?: () => Promise<string>;
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
    return <VideoPreview url={url} height={height} radius={radius} nativeControls={nativeControls} resolveRetryUrl={resolveRetryUrl} />;
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
  /**
   * Arms a display deadline. An image that neither displays nor errors within
   * `MEDIA_DISPLAY_DEADLINE_MS` of foreground time is reloaded a bounded number
   * of times, then offered for a manual retry.
   *
   * Only where the image can be seen — a focused screen, the page on screen. A
   * view the system has detached (a clipped carousel page, a covered screen)
   * never starts loading until it is attached again, and must not be declared
   * stalled for that.
   */
  watchdog?: boolean;
  /** Where the image is drawn, for the media diagnostics log. */
  diagnosticsSurface?: string;
};

export function StableMediaImage(props: StableMediaImageProps) {
  // A new source ends any pending renewal for the previously selected image.
  return <StableMediaImageSession key={`${props.cacheKey}|${props.url}`} {...props} />;
}

const NO_PROGRESS = { attemptKey: '', progressed: false, loaded: false };

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
  watchdog = false,
  diagnosticsSurface = 'app',
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
  const [stalledSourceId, setStalledSourceId] = useState<string | null>(null);
  const [retry, setRetry] = useState({ sourceId, attempt: 0 });
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = retry.sourceId === sourceId ? retry.attempt : 0;

  // The display watchdog. Each attempt is one mount of the native image; it is
  // done when that attempt displays, and stalled when the deadline passes first.
  const attemptKey = `${sourceId}#${attempt}`;
  const [displayedAttemptKey, setDisplayedAttemptKey] = useState<string | null>(null);
  const [recoveryWait, setRecoveryWait] = useState({ attemptKey: '', count: 0 });
  const progress = useRef(NO_PROGRESS);
  const recoverySlot = useRef<MediaRecoverySlot | null>(null);
  const latestOnError = useRef(onError);
  const foreground = useAppForeground(watchdog);
  const waitingForRecovery = recoveryWait.attemptKey === attemptKey && recoveryWait.count > 0;
  const deadlineArmed = watchdog
    && foreground
    && displayedAttemptKey !== attemptKey
    && failedSourceId !== sourceId;

  useEffect(() => {
    latestOnError.current = onError;
  });

  // Navigation keeps covered images mounted, and detached native views may
  // never send another callback. Their recovery ownership must end on suspend.
  useEffect(() => () => {
    recoverySlot.current?.release();
    recoverySlot.current = null;
  }, [watchdog, foreground, sourceId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      recoverySlot.current?.release();
      recoverySlot.current = null;
    };
  }, []);

  useEffect(() => {
    if (!deadlineArmed) return;
    const releaseSlot = () => {
      recoverySlot.current?.release();
      recoverySlot.current = null;
    };
    const timer = setTimeout(() => {
      if (!waitingForRecovery) {
        const reached = progress.current.attemptKey === attemptKey ? progress.current : NO_PROGRESS;
        recordMediaDiagnostic({
          kind: 'image',
          event: 'stall',
          surface: diagnosticsSurface,
          subject: cacheKey,
          attempt,
          stage: classifyImageStall(reached),
        });
      }
      if (imageRetryDelayMs(attempt) === null
        || (waitingForRecovery && recoveryWait.count * MEDIA_RECOVERY_WAIT_MS >= MEDIA_RECOVERY_MAX_WAIT_MS)) {
        releaseSlot();
        setStalledSourceId(sourceId);
        setFailedSourceId(sourceId);
        recordMediaDiagnostic({ kind: 'image', event: 'latched', surface: diagnosticsSurface, subject: cacheKey, attempt, stage: 'stalled' });
        latestOnError.current?.({ error: 'Image took too long to display' });
        return;
      }
      recoverySlot.current ??= mediaRecoveryBudget.tryAcquire();
      if (!recoverySlot.current) {
        setRecoveryWait((current) => ({
          attemptKey,
          count: current.attemptKey === attemptKey ? current.count + 1 : 1,
        }));
        return;
      }
      recordMediaDiagnostic({ kind: 'image', event: 'retry', surface: diagnosticsSurface, subject: cacheKey, attempt: attempt + 1, stage: 'stalled' });
      setRetry({ sourceId, attempt: attempt + 1 });
    }, waitingForRecovery ? MEDIA_RECOVERY_WAIT_MS : MEDIA_DISPLAY_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [attempt, attemptKey, cacheKey, deadlineArmed, diagnosticsSurface, recoveryWait, sourceId, waitingForRecovery]);

  const retryImage = async () => {
    if (pending.current) return;
    progress.current = NO_PROGRESS;
    setRecoveryWait({ attemptKey: '', count: 0 });
    setDisplayedAttemptKey(null);
    if (!resolveRetryUrl) {
      setFailedSourceId(null);
      setStalledSourceId(null);
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
        setStalledSourceId(null);
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
        label={renewalFailed
          ? 'Couldn’t refresh image. Try again.'
          : stalledSourceId === sourceId
            ? 'Taking too long to load'
            : 'Preview unavailable'}
        thumbhash={thumbhash}
        renewing={renewing}
        onRetry={() => void retryImage()}
      />
    );
  }

  const progressFor = (key: string) => (progress.current.attemptKey === key
    ? progress.current
    : { attemptKey: key, progressed: false, loaded: false });

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
      onLoadStart={watchdog ? () => {
        progress.current = { attemptKey, progressed: false, loaded: false };
      } : undefined}
      onProgress={watchdog ? () => {
        progress.current = { ...progressFor(attemptKey), progressed: true };
      } : undefined}
      onLoad={watchdog ? (event) => {
        progress.current = { ...progressFor(attemptKey), loaded: true };
        onLoad?.(event);
      } : onLoad}
      onDisplay={() => {
        if (displayedAttemptKey !== attemptKey) setDisplayedAttemptKey(attemptKey);
        if (attempt > 0) {
          recordMediaDiagnostic({ kind: 'image', event: 'recovered', surface: diagnosticsSurface, subject: cacheKey, attempt });
        }
        recoverySlot.current?.release();
        recoverySlot.current = null;
        onDisplay?.();
      }}
      onError={(event) => {
        const failure = describeImageError(event);
        const delayMs = imageRetryDelayMs(attempt);
        if (delayMs === null) {
          recoverySlot.current?.release();
          recoverySlot.current = null;
          setFailedSourceId(sourceId);
          recordMediaDiagnostic({ kind: 'image', event: 'latched', surface: diagnosticsSurface, subject: cacheKey, attempt, ...failure });
          onError?.(event);
          return;
        }
        recordMediaDiagnostic({ kind: 'image', event: 'error', surface: diagnosticsSurface, subject: cacheKey, attempt, ...failure });
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
  resolveRetryUrl,
}: {
  url: string;
  height?: number;
  radius: number;
  nativeControls: boolean;
  resolveRetryUrl?: () => Promise<string>;
}) {
  return (
    <RecoverableVideoPreview
      url={url}
      nativeControls={nativeControls}
      resolveRetryUrl={resolveRetryUrl}
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
