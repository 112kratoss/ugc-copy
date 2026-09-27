/**
 * iOS: a ••• button that opens a SwiftUI `Menu`. From iOS 26 the menu grows out
 * of the button and shrinks back into it, and every frame of that is the
 * system's. `lib/native-menu.ts` explains the arrangement; Android's dropdown
 * is `native-menu.android.tsx`.
 */
import { View } from 'react-native';

import type { NativeMenuProps, NativeMenuTrigger } from '@/components/native-menu-types';
import { useResolvedColorScheme } from '@/lib/appearance';
import { compactNativeMenu, hasNativeMenuItems, type NativeMenuAction } from '@/lib/native-menu';
import { isNativeMenuAvailable } from '@/lib/native-menu-available';
import { lowerNativeMenuShield, raiseNativeMenuShield } from '@/lib/native-menu-shield';

export type { NativeMenuProps, NativeMenuTrigger } from '@/components/native-menu-types';

type SwiftUIModules = {
  ui: typeof import('@expo/ui/swift-ui');
  modifiers: typeof import('@expo/ui/swift-ui/modifiers');
};

let swiftUI: SwiftUIModules | undefined;

/**
 * Required on first use rather than imported: the package requires its native
 * views as it loads, and a binary without them must never evaluate it.
 */
function loadSwiftUI(): SwiftUIModules {
  swiftUI ??= {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ui: require('@expo/ui/swift-ui') as typeof import('@expo/ui/swift-ui'),
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    modifiers: require('@expo/ui/swift-ui/modifiers') as typeof import('@expo/ui/swift-ui/modifiers'),
  };
  return swiftUI;
}

export function NativeMenu(props: NativeMenuProps) {
  if (!isNativeMenuAvailable() || !hasNativeMenuItems(props.model)) {
    return <View style={props.style}>{props.renderButton(props.onFallbackPress)}</View>;
  }
  return <SwiftUIMenu {...props} />;
}

function SwiftUIMenu({ accessibilityHint, accessibilityLabel, model, style, trigger }: NativeMenuProps) {
  // A menu is app UI: it follows the app's scheme even from the reel, which
  // stays dark (see `AppSchemeScope`). The glyph keeps the colour it is given.
  const scheme = useResolvedColorScheme();
  const { ui, modifiers } = loadSwiftUI();
  const { Button, ControlGroup, Host, Image, Menu, Section, Toggle } = ui;
  const menu = compactNativeMenu(model);

  // The menu's content appears when it opens (and not before): the moment to
  // raise the shield that keeps the closing tap from reaching the app.
  const whenOpen = [modifiers.onAppear(raiseNativeMenuShield)];

  // Rows are drawn from props only. A subtitle needs a label built from child
  // texts, and SwiftUI filled those in only after the menu had opened (about a
  // second later on the simulator, 2026-09-27), so the rows grew under the
  // finger. `subtitle` is left to Android and the fallback sheet.
  const renderAction = (action: NativeMenuAction) => {
    const choose = () => {
      lowerNativeMenuShield();
      action.onSelect();
    };
    const actionModifiers = action.disabled ? [modifiers.disabled(true)] : undefined;
    if (action.checked !== undefined) {
      // A pick-one row: a toggle is what draws the leading checkmark.
      return (
        <Toggle key={action.id} label={action.label} isOn={action.checked} onIsOnChange={choose} modifiers={actionModifiers} />
      );
    }
    return (
      <Button
        key={action.id}
        label={action.label}
        systemImage={action.systemImage as never}
        role={action.destructive ? 'destructive' : undefined}
        onPress={choose}
        modifiers={actionModifiers}
      />
    );
  };

  const slop = trigger.hitSlop ?? 0;
  return (
    <View style={style}>
      <Host
        colorScheme={scheme}
        style={{ width: trigger.width + slop * 2, height: trigger.height + slop * 2, margin: -slop }}
      >
        <Menu
          label={(
            // Size and colour go in as props: the view applies its own right on
            // the symbol, inside any modifier, so a `font` or `foregroundStyle`
            // modifier would lose to them.
            <Image
              systemName="ellipsis"
              size={trigger.iconSize}
              color={trigger.iconColor}
              modifiers={triggerModifiers(modifiers, trigger)}
            />
          )}
          modifiers={[
            // The default style tints the label with the accent colour, over the
            // glyph's own; plain keeps the glyph's colour and the system's press
            // dimming.
            modifiers.buttonStyle('plain'),
            modifiers.accessibilityLabel(accessibilityLabel),
            ...(accessibilityHint ? [modifiers.accessibilityHint(accessibilityHint)] : []),
          ]}
        >
          {menu.quickActions.length ? (
            <ControlGroup modifiers={whenOpen}>{menu.quickActions.map(renderAction)}</ControlGroup>
          ) : null}
          {menu.sections.map((section, index) => (
            <Section
              key={section.id}
              title={section.title}
              modifiers={index === 0 && !menu.quickActions.length ? whenOpen : undefined}
            >
              {section.items.map((item) => (item.kind === 'submenu' ? (
                <Menu
                  key={item.id}
                  label={item.label}
                  systemImage={item.systemImage}
                  modifiers={item.disabled ? [modifiers.disabled(true)] : undefined}
                >
                  {item.items.map(renderAction)}
                </Menu>
              ) : renderAction(item)))}
            </Section>
          ))}
        </Menu>
      </Host>
    </View>
  );
}

function triggerModifiers(modifiers: SwiftUIModules['modifiers'], trigger: NativeMenuTrigger) {
  const circle = trigger.circle;
  return [
    ...(trigger.vertical ? [modifiers.rotationEffect(90)] : []),
    ...(trigger.shadowColor ? [modifiers.shadow({ radius: 2, y: 1, color: trigger.shadowColor })] : []),
    ...(circle?.ring
      // The ring is a second circle a point larger behind the fill: SwiftUI's
      // `border` strokes the square frame, not the circle.
      ? [
        modifiers.frame({ width: trigger.width - 2, height: trigger.height - 2 }),
        modifiers.background(circle.fill, modifiers.shapes.circle()),
        modifiers.padding({ all: 1 }),
        modifiers.background(circle.ring, modifiers.shapes.circle()),
      ]
      : [
        modifiers.frame({
          width: trigger.width,
          height: trigger.height,
          alignment: trigger.alignment === 'trailing' ? 'trailing' : 'center',
        }),
        ...(circle ? [modifiers.background(circle.fill, modifiers.shapes.circle())] : []),
      ]),
    ...(trigger.hitSlop ? [modifiers.padding({ all: trigger.hitSlop })] : []),
    // The whole box takes the tap, slop included, as the React Native button's
    // did — not just the three dots.
    modifiers.contentShape(modifiers.shapes.rectangle()),
  ];
}
