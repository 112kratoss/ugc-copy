import { Link } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View, type TextInputProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { appTheme, type ToolAccent, accentColor } from '@/lib/theme';

export function Screen({
  children,
  scroll = true,
  insideTab = false,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  insideTab?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topPadding = appTheme.spacing.screen + (insideTab ? resolvedTopInset(insets.top) : 0);
  const bottomPadding = insideTab
    ? getMagicTabBarMetrics(width, resolvedBottomInset(insets.bottom)).contentBottomPadding
    : 36;

  if (!scroll) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: appTheme.colors.background,
          paddingHorizontal: appTheme.spacing.screen,
          paddingTop: topPadding,
          paddingBottom: bottomPadding,
        }}
      >
        {children}
      </View>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: appTheme.colors.background }}
      contentContainerStyle={{
        paddingHorizontal: appTheme.spacing.screen,
        paddingTop: topPadding,
        gap: appTheme.spacing.section,
        paddingBottom: bottomPadding,
      }}
    >
      {children}
    </ScrollView>
  );
}

export function SectionTitle({
  eyebrow,
  title,
  body,
}: {
  eyebrow?: string;
  title: string;
  body?: string;
}) {
  return (
    <View style={{ gap: 8 }}>
      {eyebrow ? (
        <Text selectable style={{ color: appTheme.colors.faint, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' }}>
          {eyebrow}
        </Text>
      ) : null}
      <Text selectable style={{ color: appTheme.colors.text, fontSize: 32, fontWeight: '800', lineHeight: 38 }}>
        {title}
      </Text>
      {body ? (
        <Text selectable style={{ color: appTheme.colors.muted, fontSize: 15, lineHeight: 22 }}>
          {body}
        </Text>
      ) : null}
    </View>
  );
}

export function Card({
  children,
  accent,
}: {
  children: React.ReactNode;
  accent?: ToolAccent;
}) {
  return (
    <View
      style={{
        gap: 12,
        borderWidth: 1,
        borderColor: accent ? `${accentColor(accent)}55` : appTheme.colors.border,
        backgroundColor: appTheme.colors.panel,
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        padding: 16,
      }}
    >
      {children}
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  loading,
  accent = 'image',
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  accent?: ToolAccent;
}) {
  return (
    <Pressable
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: appTheme.radii.pill,
        backgroundColor: disabled ? appTheme.colors.panelSoft : accentColor(accent),
        opacity: pressed ? 0.82 : disabled ? 0.55 : 1,
        paddingHorizontal: 18,
      })}
    >
      {loading ? (
        <ActivityIndicator color="#ffffff" />
      ) : (
        <Text style={{ color: '#ffffff', fontSize: 15, fontWeight: '800' }}>{label}</Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 46,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.panelSoft,
        opacity: pressed ? 0.82 : disabled ? 0.55 : 1,
        paddingHorizontal: 16,
      })}
    >
      <Text style={{ color: appTheme.colors.text, fontSize: 14, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}

export function AppTextInput({
  label,
  multiline,
  ...props
}: TextInputProps & {
  label: string;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: appTheme.colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' }}>
        {label}
      </Text>
      <TextInput
        placeholderTextColor={appTheme.colors.faint}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        style={{
          minHeight: multiline ? 112 : 48,
          borderWidth: 1,
          borderColor: appTheme.colors.border,
          borderRadius: appTheme.radii.md,
          borderCurve: 'continuous',
          backgroundColor: '#050506',
          color: appTheme.colors.text,
          fontSize: 15,
          paddingHorizontal: 14,
          paddingVertical: 12,
        }}
        {...props}
      />
    </View>
  );
}

export function StatusBlock({
  tone = 'neutral',
  title,
  body,
}: {
  tone?: 'neutral' | 'success' | 'danger';
  title: string;
  body?: string;
}) {
  const color = tone === 'success' ? appTheme.colors.success : tone === 'danger' ? appTheme.colors.danger : appTheme.colors.muted;

  return (
    <Card>
      <Text selectable style={{ color, fontSize: 16, fontWeight: '800' }}>
        {title}
      </Text>
      {body ? (
        <Text selectable style={{ color: appTheme.colors.muted, lineHeight: 21 }}>
          {body}
        </Text>
      ) : null}
    </Card>
  );
}

export function WebLinkButton({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href as never} asChild>
      <Pressable
        style={({ pressed }) => ({
          minHeight: 44,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: appTheme.radii.pill,
          borderWidth: 1,
          borderColor: appTheme.colors.borderStrong,
          opacity: pressed ? 0.82 : 1,
        })}
      >
        <Text style={{ color: appTheme.colors.text, fontWeight: '700' }}>{label}</Text>
      </Pressable>
    </Link>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>{children}</View>;
}
