import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';

import { AppText, Kicker } from '@/components/ui';
import { hexWithAlpha } from '@/lib/eased-fade';
import type { ModelCatalogKind, ModelCatalogSummary } from '@/lib/model-catalog/protocol';
import { accentColor, appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { selectWhatsNewStripModels } from '@/lib/whats-new-models';

/** The tool switcher's names for the three kinds, so a chip names the tab it opens. */
const KIND_LABELS: Record<ModelCatalogKind, string> = {
  image: 'Image',
  video: 'Video',
  motion: 'Motion',
};

/**
 * The catalog's new models, at the top of the Create tab (D9): the moment a new model matters is the
 * moment of choosing one. It reads only the catalog pages the screen has already loaded, so it adds no
 * request, and it draws nothing until one of them carries a New badge. A chip names the model and its
 * kind in the kind's accent, drawn as the screen's starter chips are, and the screen picks the model
 * the way the model picker does.
 */
export function WhatsNewModelsStrip({
  models,
  selectedModelId,
  pick = null,
  onSelect,
}: {
  models: readonly ModelCatalogSummary[];
  /** The active tool's model, whose chip shows as selected. */
  selectedModelId: string | null;
  /**
   * The screen's pick in progress: while its model's details load (no error yet) that chip turns and
   * no chip takes a press; a pick that could not land says why under the row, and its chip tries again.
   */
  pick?: { modelId: string; error: string | null } | null;
  onSelect: (model: ModelCatalogSummary) => void;
}) {
  const theme = useAppTheme();
  const listed = selectWhatsNewStripModels(models);
  if (listed.length === 0) return null;

  const loadingId = pick && !pick.error ? pick.modelId : null;
  const failure = pick?.error && listed.some((model) => model.id === pick.modelId) ? pick.error : null;

  return (
    <View testID="whats-new-models" style={{ gap: appTheme.spacing.compact }}>
      <Kicker>What’s new</Kicker>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // A chip answers its press with the keyboard up, as the rest of the page does.
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: appTheme.spacing.compact, paddingRight: appTheme.spacing.compact }}
      >
        {listed.map((model) => {
          const selected = model.id === selectedModelId;
          const loading = model.id === loadingId;
          const accent = accentColor(model.kind, theme.colors);
          const kind = KIND_LABELS[model.kind];
          return (
            <Pressable
              key={model.id}
              accessibilityRole="button"
              accessibilityLabel={`${model.displayName}, ${kind}`}
              accessibilityHint="Selects this model."
              accessibilityState={{ selected, busy: loading, disabled: loadingId !== null }}
              disabled={loadingId !== null}
              onPress={() => onSelect(model)}
              style={({ pressed }) => ({
                minHeight: appTheme.touch.compact,
                maxWidth: 240,
                flexDirection: 'row',
                alignItems: 'center',
                gap: appTheme.spacing.compact,
                paddingHorizontal: 14,
                borderRadius: appTheme.radii.pill,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor: selected ? hexWithAlpha(accent, 0.58) : theme.colors.border,
                backgroundColor: selected ? hexWithAlpha(accent, 0.12) : pressed ? theme.colors.pressed : theme.colors.surfaceStrong,
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <AppText selectable={false} variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
                {model.displayName}
              </AppText>
              {loading ? (
                <ActivityIndicator testID="whats-new-model-loading" size="small" color={accent} />
              ) : (
                <AppText selectable={false} variant="caption" color={accent}>
                  {kind}
                </AppText>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
      {failure ? (
        <AppText variant="caption" color="danger" accessibilityRole="alert">
          {failure}
        </AppText>
      ) : null}
    </View>
  );
}
