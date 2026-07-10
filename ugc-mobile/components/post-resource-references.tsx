import { ExternalLink, FileText, ImageIcon } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import { FeedMediaFrame } from '@/components/feed-media-frame';
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

  if (!referenceItems.length) return null;

  const openItem = async (item: PostResourceItem) => {
    try {
      if (item.externalUrl) {
        await onOpenUrl(item.externalUrl);
        return;
      }

      const storagePath = item.storagePath;
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
      <Text selectable style={{ color: appTheme.colors.text, fontSize: 16, fontWeight: '700' }}>
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
          const isLoading = Boolean(storagePath && loadingPaths[storagePath]);
          const previewFailed = Boolean(storagePath && failedPreviewPaths[storagePath]);
          const isOpenable = Boolean(item.externalUrl || storagePath);

          return (
            <Pressable
              accessibilityLabel={`Open reference ${item.title}`}
              accessibilityRole={isOpenable ? 'button' : undefined}
              disabled={!isOpenable}
              key={`${item.type}:${item.title}:${storagePath ?? item.externalUrl ?? index}`}
              onPress={() => void openItem(item)}
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
                  <ImageIcon size={28} color={appTheme.colors.faint} strokeWidth={2} />
                ) : (
                  <FileText size={28} color={appTheme.colors.faint} strokeWidth={2} />
                )}
              </View>
              <View style={{ padding: 10, gap: 4 }}>
                <Text selectable numberOfLines={2} style={{ color: appTheme.colors.text, fontSize: 13, lineHeight: 17, fontWeight: '700' }}>
                  {item.title}
                </Text>
                {item.description ? (
                  <Text selectable numberOfLines={2} style={{ color: appTheme.colors.muted, fontSize: 11, lineHeight: 15 }}>
                    {item.description}
                  </Text>
                ) : null}
                {!isImage && isOpenable ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <ExternalLink size={12} color={appTheme.colors.primary} strokeWidth={2.4} />
                    <Text style={{ color: appTheme.colors.primary, fontSize: 11, fontWeight: '700' }}>Open media</Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function getReferenceResourceItems(items: PostResourceItem[] | undefined) {
  return (items ?? [])
    .filter((item) => (
      item.type === 'reference_image'
      || (
        item.type === 'source_file'
        && Boolean(item.contentType?.match(/^(image|video|audio)\//))
      )
    ))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}
