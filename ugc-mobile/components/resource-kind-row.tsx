import { FileText } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { resourceKindLabel } from '@/lib/post-resource-bundle-view-model';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * What a recipe holds, as chips: "Prompt", "Files", "Remix". The resources card
 * and the remix sheet drew it from two copies of the same table, and the feed
 * and the marketplace kept two more; the words now come from one
 * (`resourceKindLabel`).
 */
export function ResourceKindRow({
  kinds,
  on = 'surface',
}: {
  kinds: readonly string[];
  /** The surface the row sits on. Each chip takes the other one, so it still reads as a chip. */
  on?: 'surface' | 'surfaceStrong';
}) {
  const theme = useAppTheme();
  const labels = Array.from(new Set(kinds.map(resourceKindLabel).filter(Boolean)));
  if (!labels.length) return null;
  const chipColor = on === 'surfaceStrong' ? theme.colors.surface : theme.colors.surfaceStrong;

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {labels.map((label) => (
        <View
          key={label}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            borderRadius: appTheme.radii.pill,
            backgroundColor: chipColor,
            paddingHorizontal: 10,
            paddingVertical: 6,
          }}
        >
          <FileText size={appTheme.icon.xs} color={theme.colors.textSecondary} />
          <Text style={{ color: theme.colors.text, ...appTheme.type.caption, fontWeight: '800' }}>{label}</Text>
        </View>
      ))}
    </View>
  );
}
