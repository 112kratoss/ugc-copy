import { RefreshCw } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

export function FeedLoadMoreErrorFooter({
  onRetry,
}: {
  onRetry: () => void;
}) {
  const theme = useAppTheme();
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
      <RefreshCw size={appTheme.icon.sm} color={theme.colors.danger} />
      <Text style={{ color: theme.colors.danger, ...appTheme.type.label }}>
        Couldn&apos;t load more. Retry
      </Text>
    </Pressable>
  );
}

export function FeedEndFooter({ message }: { message: string }) {
  const theme = useAppTheme();
  return (
    <View
      accessibilityRole="text"
      style={{ minHeight: 64, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 }}
    >
      <Text style={{ color: theme.colors.muted, textAlign: 'center', ...appTheme.type.caption }}>
        {message}
      </Text>
    </View>
  );
}
