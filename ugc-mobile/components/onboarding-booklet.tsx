import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Check, Sparkles } from 'lucide-react-native';
import type { ComponentType } from 'react';
import { Pressable, View } from 'react-native';

import { AppText, Kicker, PrimaryButton } from '@/components/ui';
import { appTheme } from '@/lib/theme';
import type { OnboardingGoal } from '@/lib/types';

type IconComponent = ComponentType<{
  color?: string;
  size?: number;
  strokeWidth?: number;
}>;

export type BookletGoal = {
  id: OnboardingGoal;
  label: string;
  body: string;
  color: string;
  image: number;
  imageLabel: string;
  icon: IconComponent;
};

export function OnboardingBookletHeader({
  onSkip,
}: {
  onSkip?: () => void;
}) {
  return (
    <View
      style={{
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
      }}
    >
      <View
        accessibilityRole="header"
        accessibilityLabel="Magicbooklet"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
      >
        <Sparkles size={26} strokeWidth={2.5} color={appTheme.colors.primary} />
        <AppText
          selectable={false}
          style={{ fontSize: 23, lineHeight: 29, fontWeight: '800', letterSpacing: -0.35 }}
        >
          Magicbooklet
        </AppText>
      </View>

      {onSkip ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Skip onboarding and explore as guest"
          hitSlop={8}
          onPress={onSkip}
          style={({ pressed }) => ({
            position: 'absolute',
            right: 0,
            minWidth: 48,
            minHeight: 48,
            alignItems: 'flex-end',
            justifyContent: 'center',
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <AppText selectable={false} variant="label" color="textSecondary">Skip</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

export function OnboardingBookletGoal({
  goals,
  selectedGoal,
  availableWidth,
  onSelect,
  onContinue,
  onExploreAsGuest,
  onBack,
}: {
  goals: BookletGoal[];
  selectedGoal: OnboardingGoal;
  availableWidth: number;
  onSelect: (goal: OnboardingGoal) => void;
  onContinue: () => void;
  onExploreAsGuest: () => void;
  onBack: () => void;
}) {
  const selected = goals.find((item) => item.id === selectedGoal) ?? goals[0];
  const artworkWidth = availableWidth + 32;
  const artworkHeight = Math.min(220, artworkWidth * (2 / 3));

  return (
    <View style={{ flex: 1 }}>
      <View style={{ marginHorizontal: 16, paddingTop: 8, gap: 8 }}>
        <Kicker color="primary">Make your first page</Kicker>
        <AppText
          heading
          style={{ fontSize: 34, lineHeight: 39, fontWeight: '900', letterSpacing: -0.7 }}
        >
          What will you create first?
        </AppText>
        <AppText variant="bodySm" color="muted" style={{ maxWidth: 330 }}>
          Pick a starting point. You can use every format whenever you like.
        </AppText>
      </View>

      <View
        style={{
          height: artworkHeight,
          marginHorizontal: -16,
          marginTop: 12,
          overflow: 'hidden',
          justifyContent: 'center',
        }}
      >
        <Image
          source={selected.image}
          accessibilityLabel={selected.imageLabel}
          cachePolicy="memory"
          contentFit="contain"
          style={{ width: '100%', height: '100%' }}
        />
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(16,16,18,0)', 'rgba(16,16,18,0.26)', appTheme.colors.background]}
          locations={[0.45, 0.72, 1]}
          style={{ position: 'absolute', inset: 0 }}
        />
      </View>

      <View accessibilityRole="radiogroup" style={{ marginHorizontal: 4, marginTop: -2, gap: 10 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {goals.map((item) => {
            const isSelected = selectedGoal === item.id;
            const Icon = item.icon;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: isSelected }}
                accessibilityLabel={`${item.label}. ${item.body}`}
                onPress={() => onSelect(item.id)}
                style={({ pressed }) => ({
                  minHeight: 88,
                  flex: 1,
                  borderRadius: 18,
                  borderCurve: 'continuous',
                  borderWidth: isSelected ? 2 : 1,
                  borderColor: isSelected ? item.color : appTheme.colors.borderSubtle,
                  backgroundColor: isSelected ? `${item.color}1f` : appTheme.colors.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 7,
                  opacity: pressed ? appTheme.opacity.pressed : 1,
                })}
              >
                <View style={{ position: 'relative' }}>
                  <Icon size={24} strokeWidth={2.2} color={isSelected ? item.color : appTheme.colors.muted} />
                  {isSelected ? (
                    <View
                      style={{
                        position: 'absolute',
                        right: -10,
                        top: -8,
                        width: 16,
                        height: 16,
                        borderRadius: 8,
                        backgroundColor: item.color,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Check size={11} strokeWidth={3} color={appTheme.colors.onPrimary} />
                    </View>
                  ) : null}
                </View>
                <AppText
                  selectable={false}
                  variant="label"
                  color={isSelected ? 'text' : 'muted'}
                  numberOfLines={1}
                >
                  {item.label}
                </AppText>
              </Pressable>
            );
          })}
        </View>
        <AppText
          accessibilityLiveRegion="polite"
          variant="caption"
          color="textSecondary"
          style={{ minHeight: 18, textAlign: 'center' }}
        >
          {selected.body}
        </AppText>
      </View>

      <View style={{ marginTop: 'auto', marginHorizontal: 12, paddingTop: 18, gap: 0 }}>
        <PrimaryButton
          label="Continue to account setup"
          size="roomy"
          accessibilityHint={`Continue with ${selected.label.toLowerCase()} as your first format`}
          onPress={onContinue}
        />
        <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={onBack}
            style={({ pressed }) => ({
              minHeight: 48,
              justifyContent: 'center',
              paddingHorizontal: 12,
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <AppText selectable={false} variant="bodySm" color="muted">Back</AppText>
          </Pressable>
          <View style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: appTheme.colors.faint }} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Explore as guest"
            onPress={onExploreAsGuest}
            style={({ pressed }) => ({
              minHeight: 48,
              justifyContent: 'center',
              paddingHorizontal: 12,
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <AppText selectable={false} variant="bodySm" color="muted">Explore as guest</AppText>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
