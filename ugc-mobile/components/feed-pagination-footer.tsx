import { RefreshCw } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { appTheme } from '@/lib/theme';

export function FeedLoadMoreErrorFooter({
  onRetry,
}: {
  onRetry: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Couldn't load more. Retry"
      onPress={onRetry}
      style={({ pressed }) => ({
        minHeight: 64,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 8,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <RefreshCw size={17} color={appTheme.colors.danger} />
      <Text style={{ color: appTheme.colors.danger, ...appTheme.type.label }}>
        Couldn&apos;t load more. Retry
      </Text>
    </Pressable>
  );
}

export function FeedEndFooter({ message }: { message: string }) {
  return (
    <View
      accessibilityRole="text"
      style={{ minHeight: 64, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 }}
    >
      <Text style={{ color: appTheme.colors.muted, textAlign: 'center', ...appTheme.type.caption }}>
        {message}
      </Text>
    </View>
  );
}
