import { ExternalLink, FileText, ImageIcon } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import { FeedMediaFrame } from '@/components/feed-media-frame';
import { MediaLightbox, type LightboxMediaItem } from '@/components/media-lightbox';
import { appTheme } from '@/lib/theme';
import type { PostResourceItem } from '@/lib/types';

type PostResourceReferencesProps = {
  items: PostResourceItem[] | undefined;
  onError?: (message: string) => void;
  onOpenUrl: (url: string) => Promise<void>;
  resolveFileUrl: (storagePath: string) => Promise<string>;
};

export function PostResourceReferences({
  items,
  onError,
  onOpenUrl,
  resolveFileUrl,
}: PostResourceReferencesProps) {
  const referenceItems = useMemo(
    () => getReferenceResourceItems(items),
    [items]
  );
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});
  const [failedPreviewPaths, setFailedPreviewPaths] = useState<Record<string, boolean>>({});
  // Keyed by item, not by position: signed URLs resolve in any order, so the
  // list of viewable items can grow while the lightbox is open.
  const [lightboxKey, setLightboxKey] = useState<string | null>(null);
  const requestedPaths = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const storagePaths = referenceItems
      .map((item) => item.storagePath)
      .filter((storagePath): storagePath is string => Boolean(storagePath));

    for (const storagePath of storagePaths) {
      if (requestedPaths.current.has(storagePath)) continue;

      requestedPaths.current.add(storagePath);
      setLoadingPaths((current) => ({ ...current, [storagePath]: true }));
      void resolveFileUrl(storagePath)
        .then((url) => {
          if (!mounted.current) return;
          setFileUrls((current) => ({ ...current, [storagePath]: url }));
        })
        .catch(() => {
          requestedPaths.current.delete(storagePath);
        })
        .finally(() => {
          if (!mounted.current) return;
          setLoadingPaths((current) => {
            const next = { ...current };
            delete next[storagePath];
            return next;
          });
        });
    }
  }, [referenceItems, resolveFileUrl]);

  // Everything the app can show itself: storage-backed images and videos
  // whose signed URL has arrived. External links stay links, and audio has
  // no in-app player, so both still hand off to the browser.
  const lightboxItems = useMemo<LightboxMediaItem[]>(
    () => referenceItems.flatMap((item, index) => {
      const mediaKind = referenceMediaKind(item);
      const url = item.storagePath ? fileUrls[item.storagePath] : null;
      if (!mediaKind || !url) return [];
      return [{ id: referenceKey(item, index), url, mediaKind, label: item.title, caption: item.description }];
    }),
    [fileUrls, referenceItems]
  );
  const lightboxIndex = lightboxKey ? lightboxItems.findIndex((item) => item.id === lightboxKey) : -1;

  if (!referenceItems.length) return null;

  const openItem = async (item: PostResourceItem, index: number) => {
    try {
      const storagePath = item.storagePath;
      if (storagePath && referenceMediaKind(item)) {
        const url = fileUrls[storagePath] ?? await resolveFileUrl(storagePath);
        setFileUrls((current) => ({ ...current, [storagePath]: url }));
        setLightboxKey(referenceKey(item, index));
        return;
      }

      if (item.externalUrl) {
        await onOpenUrl(item.externalUrl);
        return;
      }

      if (!storagePath) return;
      const url = fileUrls[storagePath] ?? await resolveFileUrl(storagePath);
      setFileUrls((current) => ({ ...current, [storagePath]: url }));
      await onOpenUrl(url);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Failed to open this reference.');
    }
  };

  return (
    <View style={{ gap: 10 }}>
      <Text selectable style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>
        References
      </Text>
      <ScrollView
        horizontal
        contentContainerStyle={{ gap: 10 }}
        showsHorizontalScrollIndicator={false}
      >
        {referenceItems.map((item, index) => {
          const storagePath = item.storagePath;
          const signedUrl = storagePath ? fileUrls[storagePath] : null;
          const isImage = Boolean(item.contentType?.startsWith('image/'));
          const mediaLabel = item.contentType?.startsWith('video/')
            ? 'Open video'
            : item.contentType?.startsWith('audio/')
              ? 'Open audio'
              : 'Open media';
          const isLoading = Boolean(storagePath && loadingPaths[storagePath]);
          const previewFailed = Boolean(storagePath && failedPreviewPaths[storagePath]);
          const isOpenable = Boolean(item.externalUrl || storagePath);

          return (
            <Pressable
              accessibilityLabel={`Open reference ${item.title}`}
              accessibilityRole={isOpenable ? 'button' : undefined}
              disabled={!isOpenable}
              key={referenceKey(item, index)}
              onPress={() => void openItem(item, index)}
              style={({ pressed }) => ({
                width: 142,
                minHeight: 222,
                borderRadius: 16,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor: appTheme.colors.border,
                backgroundColor: pressed ? appTheme.colors.surfaceStrong : appTheme.colors.panel,
                overflow: 'hidden',
              })}
            >
              <View style={{ height: 166, backgroundColor: appTheme.colors.surfaceInset, alignItems: 'center', justifyContent: 'center' }}>
                {isImage && signedUrl && !previewFailed ? (
                  <FeedMediaFrame
                    kind="image"
                    onImageError={() => {
                      if (!storagePath) return;
                      setFailedPreviewPaths((current) => ({ ...current, [storagePath]: true }));
                    }}
                    radius={0}
                    style={{ width: '100%', height: '100%' }}
                    transition={120}
                    url={signedUrl}
                  />
                ) : isLoading ? (
                  <ActivityIndicator color={appTheme.colors.primary} />
                ) : isImage ? (
                  <ImageIcon size={appTheme.icon.hero} color={appTheme.colors.faint} />
                ) : (
                  <FileText size={appTheme.icon.hero} color={appTheme.colors.faint} />
                )}
              </View>
              <View style={{ padding: 10, gap: 4 }}>
                <Text selectable numberOfLines={2} style={{ color: appTheme.colors.text, ...appTheme.type.label }}>
                  {item.title}
                </Text>
                {item.description ? (
                  <Text selectable numberOfLines={2} style={{ color: appTheme.colors.muted, ...appTheme.type.caption, fontWeight: '400' }}>
                    {item.description}
                  </Text>
                ) : null}
                {!isImage && isOpenable ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <ExternalLink size={appTheme.icon.xs} color={appTheme.colors.primary} />
                    <Text style={{ color: appTheme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>{mediaLabel}</Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
      <MediaLightbox
        items={lightboxItems}
        activeIndex={lightboxIndex >= 0 ? lightboxIndex : null}
        onClose={() => setLightboxKey(null)}
        onNavigate={(index) => setLightboxKey(lightboxItems[index]?.id ?? null)}
      />
    </View>
  );
}

function referenceKey(item: PostResourceItem, index: number) {
  return item.id ?? `${item.type}:${item.title}:${item.storagePath ?? item.externalUrl ?? index}`;
}

/** What the app can put on its own lightbox stage. Audio is not on it. */
export function referenceMediaKind(item: Pick<PostResourceItem, 'type' | 'contentType'>): 'image' | 'video' | null {
  if (item.contentType?.startsWith('image/')) return 'image';
  if (item.contentType?.startsWith('video/')) return 'video';
  if (item.type === 'reference_image') return 'image';
  if (item.type === 'reference_video') return 'video';
  return null;
}

export function getReferenceResourceItems(items: PostResourceItem[] | undefined) {
  return (items ?? [])
    .filter((item) => (
      item.type === 'reference_image'
      || item.type === 'reference_video'
      || item.type === 'reference_audio'
      || (
        item.type === 'source_file'
        && Boolean(item.contentType?.match(/^(image|video|audio)\//))
      )
    ))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}
