import { Copy } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { ResourceAction } from '@/components/resource-action';
import { appTheme } from '@/lib/theme';

/** The preview is short; copying always uses the complete source. */
export function ResourcePrompt({ text, onCopy }: { text: string; onCopy?: (text: string) => Promise<void> | void }) {
  const [expanded, setExpanded] = useState(false);
  // A different prompt starts collapsed again. Owning that here rather than
  // asking every caller for a `key` keeps a whole prompt out of the key, and
  // a caller who forgets one out of the wrong state.
  const [shownText, setShownText] = useState(text);
  if (shownText !== text) {
    setShownText(text);
    setExpanded(false);
  }
  const canExpand = text.length > 220 || text.split('\n').length > 5;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        {onCopy ? <ResourceAction label="Copy prompt" confirmLabel="Copied" icon={<Copy size={appTheme.icon.xs} color={appTheme.colors.success} />} onPress={() => onCopy(text)} /> : null}
        {canExpand ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Collapse prompt' : 'Show full prompt'}
            accessibilityState={{ expanded }}
            onPress={() => setExpanded((value) => !value)}
            style={({ pressed }) => ({ minHeight: 48, justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
          >
            <Text style={{ color: appTheme.colors.textSecondary, ...appTheme.type.bodySm }}>{expanded ? 'Collapse prompt' : 'Show full prompt'}</Text>
          </Pressable>
        ) : null}
      </View>
      <Text selectable numberOfLines={canExpand && !expanded ? 5 : undefined} style={{ color: appTheme.colors.textSecondary, ...appTheme.type.bodySm }}>{text}</Text>
    </View>
  );
}
