import { rememberDecodedImageAspectRatio } from '@/lib/decoded-image-aspect-ratio';
import { Image, type ImageProps } from 'expo-image';
import { RecoverableVideoPreview } from '@/components/recoverable-video-preview';
import { ImageOff } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';

import { useAppForeground } from '@/lib/app-foreground';
import { describeImageError, recordMediaDiagnostic } from '@/lib/media-diagnostics';
import { imageRetryDelayMs } from '@/lib/media-performance';
import {
  MEDIA_DISPLAY_DEADLINE_MS,
  MEDIA_RECOVERY_WAIT_MS,
  MEDIA_RECOVERY_MAX_WAIT_MS,
  classifyImageStall,
  mediaAutoRetryDelayMs,
  mediaRecoveryBudget,
  type MediaRecoverySlot,
} from '@/lib/media-recovery';
import { useMediaSource } from '@/lib/use-media-source';
import { hexWithAlpha } from '@/lib/eased-fade';
import { appTheme, mediaColors, themes } from '@/lib/theme';
import { ThemeScope, useAppTheme } from '@/lib/theme-context';

export function MediaPreview({
  url,
  kind,
  height,
  radius = appTheme.radii.lg,
  nativeControls = true,
  letterbox = false,
  playerHeld = false,
  resolveRetryUrl,
}: {
  url: string | null | undefined;
  kind?: 'image' | 'video' | null;
  /** A frame this tall and as wide as its container. Without it, a 4:5 card of the container's width. */
  height?: number;
  radius?: number;
  nativeControls?: boolean;
  /**
   * Show the whole picture, centred on black bands. Without it a picture is
   * cropped to fill the frame. A clip is shown whole on black either way: the
   * player never crops it.
   */
  letterbox?: boolean;
  /**
   * A clip's frame without its player, for a surface that is still arriving:
   * the player is built on the main thread, where an entrance is drawn. The
   * frame is the black a clip plays on, so the player takes its place with no
   * change of size or colour. A picture is drawn either way.
   */
  playerHeld?: boolean;
  /** A fresh link for a video whose own has stopped working. */
  resolveRetryUrl?: () => Promise<string>;
}) {
  const theme = useAppTheme();
  const { requestKey } = useMediaSource(url || '');
  const sourceKey = `${url}|${requestKey}`;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const imageFailed = failedUrl === sourceKey;

  if (!url) {
    return <MediaFallback height={height} radius={radius} label="No media" />;
  }

  if (kind === 'video') {
    if (playerHeld) return <View style={videoFrame(height, radius)} />;
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
      contentFit={letterbox ? 'contain' : 'cover'}
      onError={() => setFailedUrl(sourceKey)}
      style={{
        ...previewFrame(height),
        borderRadius: radius,
        borderWidth: 1,
        borderColor: theme.colors.border,
        // A neutral tile rather than near-black: while a large preview loads,
        // #050506 is indistinguishable from the page behind it, so the card
        // reads as a hole punched in the layout instead of media on its way.
        // A letterboxed picture sits on the black its bands are drawn in.
        backgroundColor: letterbox ? mediaColors.mediaGround : theme.colors.panelSoft,
      }}
    />
  );
}

/**
 * The box a preview fills: its container's width at the given height, or a 4:5
 * card of that width when no height is given. The ratio and a height never go
 * together. Given both, Yoga takes the width from the height (300 gives 240)
 * and never reads `width: '100%'`, so the box sits against the left edge of a
 * wider column and runs past the edge of a narrower one.
 */
function previewFrame(height: number | undefined) {
  return height === undefined
    ? { width: '100%' as const, aspectRatio: 4 / 5 }
    : { width: '100%' as const, height };
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
   * of times, then offered for a manual retry — and, while it stays on screen,
   * keeps retrying on its own behind that plate (`mediaAutoRetryDelayMs`).
   *
   * Only where the image can be seen — a focused screen, the page on screen. A
   * view the system has detached (a clipped carousel page, a covered screen)
   * never starts loading until it is attached again, and must not be declared
   * stalled for that.
   *
   * The parent must be the box the image fills, as the frame and tile
   * components are: the plate a silent retry hides behind fills that parent.
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
/** The silent retries of a latched stall: how many so far, whether one is loading now, and when the plate went up. */
const NO_AUTO_RETRY = { sourceId: '', count: 0, loading: false, latchedAt: 0 };

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
  const [autoRetry, setAutoRetry] = useState(NO_AUTO_RETRY);
  const progress = useRef(NO_PROGRESS);
  const recoverySlot = useRef<MediaRecoverySlot | null>(null);
  const latestOnError = useRef(onError);
  const foreground = useAppForeground(watchdog);
  const waitingForRecovery = recoveryWait.attemptKey === attemptKey && recoveryWait.count > 0;
  const latched = failedSourceId === sourceId;
  const latchedByStall = latched && stalledSourceId === sourceId;
  // A stall's silent retry: the image loads again while the plate stays up, so
  // the reader sees the picture the moment it displays and nothing before.
  const retryingBehindPlate = latchedByStall && autoRetry.sourceId === sourceId && autoRetry.loading;
  const deadlineArmed = watchdog
    && foreground
    && displayedAttemptKey !== attemptKey
    && (!latched || retryingBehindPlate);

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
        // The plate goes up (or stays up); the next silent retry waits from now.
        setAutoRetry((current) => ({
          sourceId,
          count: current.sourceId === sourceId ? current.count : 0,
          loading: false,
          latchedAt: Date.now(),
        }));
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

  // A stalled image that stays on screen tries again on its own, behind the
  // plate, so a loader that has come back is noticed without a tap. Foreground
  // time only, and never after an explicit failure: that names a file which is
  // not going to appear. The wait counts from when the plate went up, so a
  // screen returned to after a long absence retries at once.
  const autoRetryDue = latchedByStall && !retryingBehindPlate && watchdog && foreground && autoRetry.sourceId === sourceId;
  useEffect(() => {
    if (!autoRetryDue) return;
    const wait = Math.max(0, autoRetry.latchedAt + mediaAutoRetryDelayMs(autoRetry.count) - Date.now());
    const timer = setTimeout(() => {
      progress.current = NO_PROGRESS;
      setRecoveryWait({ attemptKey: '', count: 0 });
      setDisplayedAttemptKey(null);
      setRetry({ sourceId, attempt: 0 });
      setAutoRetry((current) => ({ ...current, sourceId, count: current.count + 1, loading: true }));
      recordMediaDiagnostic({ kind: 'image', event: 'retry', surface: diagnosticsSurface, subject: cacheKey, attempt: 0, stage: 'auto' });
    }, wait);
    return () => clearTimeout(timer);
  }, [autoRetry.count, autoRetry.latchedAt, autoRetryDue, cacheKey, diagnosticsSurface, sourceId]);

  const retryImage = async () => {
    if (pending.current) return;
    progress.current = NO_PROGRESS;
    setRecoveryWait({ attemptKey: '', count: 0 });
    setDisplayedAttemptKey(null);
    setAutoRetry(NO_AUTO_RETRY);
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

  const progressFor = (key: string) => (progress.current.attemptKey === key
    ? progress.current
    : { attemptKey: key, progressed: false, loaded: false });

  const plate = latched ? (
    <MediaFallback
      key="plate"
      radius={0}
      fill={retryingBehindPlate}
      label={renewalFailed
        ? 'Couldn’t refresh image. Try again.'
        : latchedByStall
          ? 'Taking too long to load'
          : 'Preview unavailable'}
      thumbhash={thumbhash}
      renewing={renewing}
      retrying={retryingBehindPlate}
      onRetry={() => void retryImage()}
    />
  ) : null;

  // One fragment in every state, with keyed children: the image mounted for
  // a silent retry is the very element left on screen once the plate goes,
  // so the picture does not load a second time when it is revealed.
  const image = latched && !retryingBehindPlate ? null : (
    <Image
      key={`image:${cacheKey}:${attempt}:${requestKey}`}
      source={{ ...source, cacheKey }}
      placeholder={thumbhash ? { thumbhash } : undefined}
      placeholderContentFit={contentFit}
      contentFit={contentFit}
      cachePolicy="memory-disk"
      recyclingKey={cacheKey}
      // expo-image 55's Android fade can recycle a newer image after a covered
      // screen resizes, leaving both native layers GONE when it returns. Use
      // the synchronous swap until the native transition ownership fix ships.
      transition={Platform.OS === 'android' ? 0 : transition}
      onLoadStart={watchdog ? () => {
        progress.current = { attemptKey, progressed: false, loaded: false };
      } : undefined}
      onProgress={watchdog ? () => {
        progress.current = { ...progressFor(attemptKey), progressed: true };
      } : undefined}
      onLoad={(event) => {
        rememberDecodedImageAspectRatio(initialUrl, event.source.width, event.source.height);
        if (watchdog) progress.current = { ...progressFor(attemptKey), loaded: true };
        onLoad?.(event);
      }}
      onDisplay={() => {
        if (displayedAttemptKey !== attemptKey) setDisplayedAttemptKey(attemptKey);
        if (retryingBehindPlate) {
          // The picture is on screen under the plate: take the plate away.
          setFailedSourceId(null);
          setStalledSourceId(null);
          setAutoRetry(NO_AUTO_RETRY);
          recordMediaDiagnostic({ kind: 'image', event: 'recovered', surface: diagnosticsSurface, subject: cacheKey, attempt: autoRetry.count, stage: 'auto' });
        } else if (attempt > 0) {
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
          // An answer, not a silence: no more silent retries for this source.
          setStalledSourceId(null);
          setAutoRetry(NO_AUTO_RETRY);
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

  return (
    <>
      {image}
      {plate}
    </>
  );
}

function MediaFallback({
  height,
  radius,
  label,
  thumbhash,
  onRetry,
  renewing = false,
  retrying = false,
  fill = false,
}: {
  height?: number;
  radius: number;
  label: string;
  thumbhash?: string | null;
  onRetry?: () => void;
  renewing?: boolean;
  /** A silent retry is loading behind this plate. */
  retrying?: boolean;
  /** Cover the parent instead of taking the preview's own frame: the plate over a retrying image. */
  fill?: boolean;
}) {
  const theme = useAppTheme();
  const frameStyle = {
    // The frame the picture would have had, so nothing around it moves when it fails.
    ...(fill
      ? { position: 'absolute' as const, inset: 0 }
      : { ...previewFrame(height), borderWidth: 1, borderColor: theme.colors.border }),
    borderRadius: radius,
    backgroundColor: theme.colors.surfaceInset,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 8,
    overflow: 'hidden' as const,
  };
  // Over the dimmed thumbhash the plate is dark whatever the scheme, so its text
  // takes the dark palette; on the bare plate it follows the app.
  const ink = thumbhash ? themes.dark.colors : theme.colors;

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
          <View pointerEvents="none" style={{ position: 'absolute', inset: 0, backgroundColor: hexWithAlpha(mediaColors.mediaGround, 0.55) }} />
        </>
      ) : null}
      <ImageOff size={28} color={ink.faint} />
      <Text style={{ color: ink.textSecondary, fontSize: 12, fontWeight: '800' }}>{label}</Text>
      {onRetry ? (
        <Text style={{ color: ink.faint, fontSize: 11, fontWeight: '700' }}>
          {renewing ? 'Refreshing image…' : retrying ? 'Trying again…' : 'Tap to retry'}
        </Text>
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
      accessibilityState={{ disabled: renewing, busy: renewing || retrying }}
      disabled={renewing}
      onPress={onRetry}
      style={({ pressed }) => [frameStyle, { opacity: pressed ? appTheme.opacity.pressed : 1 }]}
    >
      {content}
    </Pressable>
  );
}

/** The box a clip plays in, and what stands in for it while its player is held. */
function videoFrame(height: number | undefined, radius: number) {
  return {
    ...previewFrame(height),
    borderRadius: radius,
    // The player shows its clip whole and its view is transparent, with
    // controls or without, so this colour is the bands beside a clip of
    // any other shape than the frame. They are black in both schemes, as
    // in a video player: the scheme's placeholder made them beige in light.
    backgroundColor: mediaColors.mediaGround,
  };
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
  // A clip on black in both schemes, so what the player draws over it (its
  // loading spinner, its failure notice) takes the dark palette, as in the
  // lightbox. The light scheme's coral is too deep to read on black.
  return (
    <ThemeScope scheme="dark">
      <RecoverableVideoPreview
        url={url}
        nativeControls={nativeControls}
        resolveRetryUrl={resolveRetryUrl}
        style={videoFrame(height, radius)}
      />
    </ThemeScope>
  );
}
