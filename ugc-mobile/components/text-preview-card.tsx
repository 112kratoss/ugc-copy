import { LinearGradient } from 'expo-linear-gradient';
import { FileText } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { appTheme } from '@/lib/theme';

export function TextPreviewCard({
  text,
  accent,
  height,
  radius,
  lines = 5,
  compact = false,
}: {
  text: string;
  accent: string;
  height: number;
  radius: number;
  lines?: number;
  compact?: boolean;
}) {
  return (
    <LinearGradient
      colors={['#141018', '#161020', '#090914']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{
        height,
        borderRadius: radius,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: `${accent}4d`,
        justifyContent: 'flex-end',
        overflow: 'hidden',
        padding: compact ? 10 : 14,
      }}
    >
      <View style={{ position: 'absolute', inset: 0, backgroundColor: `${accent}14` }} />
      <View style={{ gap: compact ? 7 : 12 }}>
        <View
          style={{
            width: compact ? 24 : 34,
            height: compact ? 24 : 34,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: compact ? 12 : 17,
            backgroundColor: `${accent}24`,
            borderWidth: 1,
            borderColor: `${accent}55`,
          }}
        >
          <FileText size={compact ? 13 : 18} color={accent} strokeWidth={2.4} />
        </View>
        <Text numberOfLines={lines} style={{ color: appTheme.colors.text, fontSize: compact ? 12 : 17, lineHeight: compact ? 15 : 22, fontWeight: '900' }}>
          {text}
        </Text>
      </View>
    </LinearGradient>
  );
}
