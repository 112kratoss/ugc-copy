import type { ReactNode, RefObject } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';

import { AppText } from '@/components/ui';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * The post composer's field primitives: the panel a group of fields sits in,
 * the compact label row, the input and the error line under it. Shared with
 * the name-and-handle card (`public-identity-card.tsx`), which the composer
 * draws on step 2 and the sheet a list opens when a post is made public draws
 * on its own, so the two look like one form.
 */

export function ComposerFieldShell({ children }: { children: ReactNode }) {
  const theme = useAppTheme();
  return (
    <View
      style={{
        gap: 8,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.surface,
        padding: 14,
      }}
    >
      {children}
    </View>
  );
}

export function CompactFieldLabel({
  label,
  required = false,
  optional = false,
  valueLength,
  maxLength,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  valueLength?: number;
  maxLength?: number;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <AppText variant="label">{label}</AppText>
      {required ? <AppText variant="caption" color="primary">Required</AppText> : null}
      {optional ? <AppText variant="caption" color="faint">Optional</AppText> : null}
      {typeof valueLength === 'number' && typeof maxLength === 'number' ? (
        <AppText variant="caption" color="faint" style={{ marginLeft: 'auto' }}>{`${valueLength}/${maxLength}`}</AppText>
      ) : null}
    </View>
  );
}

export function ComposerInput({
  inputRef,
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  accessibilityHint,
  multiline,
  minHeight,
  editable = true,
  ...inputProps
}: {
  inputRef?: RefObject<TextInput | null>;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  multiline?: boolean;
  minHeight?: number;
  editable?: boolean;
} & Omit<TextInputProps, 'ref' | 'value' | 'onChangeText' | 'placeholder' | 'multiline' | 'editable' | 'style'>) {
  const theme = useAppTheme();
  return (
    <TextInput
      {...inputProps}
      ref={inputRef}
      accessibilityLabel={accessibilityLabel ?? placeholder}
      accessibilityHint={accessibilityHint}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.faint}
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : 'center'}
      editable={editable}
      style={{
        minHeight: multiline ? minHeight ?? 112 : appTheme.touch.compact,
        borderRadius: 14,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: editable ? theme.colors.surfaceInset : theme.colors.surface,
        color: editable ? theme.colors.text : theme.colors.faint,
        ...appTheme.type.bodySm,
        fontWeight: '500',
        paddingHorizontal: appTheme.spacing.gap,
        paddingVertical: appTheme.spacing.gap,
      }}
    />
  );
}

export function FieldErrorText({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <AppText accessibilityRole="alert" variant="caption" color="danger">
      {message}
    </AppText>
  );
}
