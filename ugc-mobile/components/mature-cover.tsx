import { EyeOff } from 'lucide-react-native';
import { createContext } from 'react';
import { Linking, Pressable, View } from 'react-native';

import { AppText, SecondaryButton } from '@/components/ui';
import type { MatureReveal } from '@/lib/nsfw-reveal-policy';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * Whether the mature media drawn below is still covered, for media a screen
 * reaches only through components that pass other props along: a purchase's
 * reference pictures, inside `PostResourceBundleContent`. Off unless a screen
 * sets it.
 */
export const MatureMediaCovered = createContext(false);

type MatureCoverProps =
  | {
    variant: 'tile';
    reveal?: MatureReveal;
    /** Left out, the tile only covers, and another control on the screen shows it. */
    onShow?: () => void;
  }
  | {
    variant: 'card';
    reveal: MatureReveal;
    onShow: () => void;
    /** Where the website turns mature content on, offered while it is off. */
    websiteUrl?: string | null;
  };

/**
 * What a mature post's picture is drawn as until the viewer asks for it: a
 * list tile (filling the box the thumbnail would), or the 4:5 card a cover
 * fills, so nothing around it moves when the picture takes its place.
 *
 * The purchase is the entitlement, so Show draws the picture in place without
 * asking the server, but only where `reveal` (`useMatureReveal`) allows it:
 * on iOS once the viewer has turned mature content on from the website, as a
 * post's reveal asks, and never on Android. Otherwise the card says why it
 * stays covered and the tile offers nothing. Nothing under the plate is loaded
 * until it goes.
 */
export function MatureCover(props: MatureCoverProps) {
  return props.variant === 'tile'
    ? <MatureTile reveal={props.reveal} onShow={props.onShow} />
    : <MatureCard reveal={props.reveal} onShow={props.onShow} websiteUrl={props.websiteUrl ?? null} />;
}

function MatureTile({ reveal, onShow }: { reveal?: MatureReveal; onShow?: () => void }) {
  const theme = useAppTheme();
  const plate = {
    position: 'absolute' as const,
    inset: 0,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 2,
    backgroundColor: theme.colors.surfaceInset,
  };

  if (reveal !== 'show' || !onShow) {
    return (
      <View style={plate}>
        <EyeOff size={appTheme.icon.sm} color={theme.colors.muted} />
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Show mature content"
      onPress={onShow}
      style={({ pressed }) => ({ ...plate, opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <EyeOff size={appTheme.icon.xs} color={theme.colors.muted} />
      <AppText selectable={false} variant="caption" color="text">Show</AppText>
    </Pressable>
  );
}

function MatureCard({
  reveal,
  onShow,
  websiteUrl,
}: {
  reveal: MatureReveal;
  onShow: () => void;
  websiteUrl: string | null;
}) {
  const theme = useAppTheme();

  return (
    <View
      style={{
        width: '100%',
        aspectRatio: 4 / 5,
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surfaceInset,
        alignItems: 'center',
        justifyContent: 'center',
        gap: appTheme.spacing.gap,
        padding: appTheme.spacing.panel,
      }}
    >
      <EyeOff size={appTheme.icon.hero} color={theme.colors.muted} />
      <AppText variant="cardTitle" color="text">Mature content</AppText>
      <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>
        {reveal === 'show'
          ? 'The creator marked this post NSFW. It stays covered until you choose to see it.'
          : reveal === 'never'
            ? 'The creator marked this post NSFW. Mature posts stay covered in this app.'
            : 'The creator marked this post NSFW.'}
      </AppText>
      {/* The post notice's guidance, since only the website turns it on. */}
      {reveal === 'website' ? (
        <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>
          Mature content is off by default. Adults can enable it on the Magicbooklet website, then return here to show it.
        </AppText>
      ) : null}
      {reveal === 'show' ? (
        <SecondaryButton label="Show" accessibilityHint="Shows this post's media here" onPress={onShow} />
      ) : reveal === 'website' && websiteUrl ? (
        <SecondaryButton label="Manage on website" onPress={() => void Linking.openURL(websiteUrl)} />
      ) : null}
    </View>
  );
}
