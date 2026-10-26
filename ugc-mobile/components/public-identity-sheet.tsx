import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { Overlay } from '@/components/overlay-host';
import { PublicIdentityCard } from '@/components/public-identity-card';
import {
  SheetBackdrop,
  SheetGrabber,
  SheetPanel,
  sheetMotion,
  sheetPanelStyle,
  useSheetDismissDrag,
  useSheetPresentation,
} from '@/components/sheet-chrome';
import { AppText, PrimaryButton, SecondaryButton } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useReducedMotion } from '@/lib/motion';
import { profileQueryKey } from '@/lib/profile-stats';
import {
  getInitialPublicIdentity,
  readPublicIdentitySaveError,
  validatePublicIdentity,
  type PublicIdentityDraft,
  type PublicIdentityErrors,
} from '@/lib/public-identity';
import { registerPublicIdentityPresenter, type PublicIdentityOutcome } from '@/lib/public-identity-prompt';
import { resolvedBottomInset } from '@/lib/safe-area';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { useClaimPublicIdentity } from '@/lib/use-claim-public-identity';
import { useHardwareBack } from '@/lib/use-hardware-back';

/** The question on screen, everything waiting on its answer, and whose profile it is for. */
type Question = {
  id: number;
  settles: Array<(outcome: PublicIdentityOutcome) => void>;
  accountId: string | null;
};

let nextQuestionId = 1;

/**
 * The surface behind `requestPublicIdentity`. Mounted once, inside
 * `OverlayHost` in the root layout, beside the action sheet that offers
 * Public: a creator whose profile cannot publish publicly yet is asked for
 * their name and handle here when the server refuses the change, and the
 * change goes out again once they are saved.
 *
 * Through the overlay host rather than a `Modal` because it holds text fields
 * (`hig-modality.test.ts`), and the overlay is drawn over the reel the change
 * can be made from.
 */
export function PublicIdentitySheetHost() {
  const [question, setQuestion] = useState<Question | null>(null);
  const [visible, setVisible] = useState(false);
  // The question still waiting for its answer, cleared as it is answered, so a
  // press while the sheet leaves cannot answer it twice.
  const openRef = useRef<Question | null>(null);
  // The signed-in account the sheet would save to; a guest has no profile to
  // publish under (`useAuth` gives a guest no user at all).
  const { user } = useAuth();
  const accountId = user && !user.is_anonymous ? user.id : null;
  const accountIdRef = useRef(accountId);
  useEffect(() => {
    accountIdRef.current = accountId;
  }, [accountId]);

  useEffect(() => registerPublicIdentityPresenter((settle) => {
    // One question at a time, and one answer for everything waiting on it: a
    // second refusal while the sheet is up (two posts made public together)
    // waits for the same answer instead of putting the first post back.
    const open = openRef.current;
    if (open) {
      open.settles.push(settle);
      return;
    }
    // Asked once the session has already ended (the refusal came back after
    // the teardown): nobody is signed in to save a name and handle for.
    if (!accountIdRef.current) {
      settle({ status: 'cancelled' });
      return;
    }
    // An overlay takes no window focus, so the keyboard of the page it opens
    // over would stay up over the sheet: it goes as the sheet is asked for.
    Keyboard.dismiss();
    const next = { id: nextQuestionId++, settles: [settle], accountId: accountIdRef.current };
    openRef.current = next;
    setQuestion(next);
    setVisible(true);
  }), []);

  const answer = (outcome: PublicIdentityOutcome) => {
    const open = openRef.current;
    if (!open) return;
    openRef.current = null;
    setVisible(false);
    for (const settle of open.settles) settle(outcome);
  };

  // The server can end the session while the sheet is up: a 409
  // ACCOUNT_DELETING (the account's deletion was asked for on another device)
  // leaves the device a guest on Home. The sheet lives above the navigator, so
  // nothing else puts it away, and its answer would be saved to nobody's
  // profile: the question goes, as if cancelled, and the post stays as it was.
  // A refresh of the same account's session changes nothing here.
  useEffect(() => {
    const open = openRef.current;
    if (open && open.accountId !== accountId) answer({ status: 'cancelled' });
  }, [accountId]);

  if (!question) return null;
  return (
    <PublicIdentitySheet
      key={question.id}
      visible={visible}
      onAnswer={answer}
      onExited={() => setQuestion((current) => (current?.id === question.id ? null : current))}
    />
  );
}

function PublicIdentitySheet({
  visible,
  onAnswer,
  onExited,
}: {
  visible: boolean;
  onAnswer: (outcome: PublicIdentityOutcome) => void;
  onExited: () => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const { api, user } = useAuth();
  const claimIdentity = useClaimPublicIdentity();
  const bottomInset = resolvedBottomInset(insets.bottom);

  // The composer's own read of the profile, so a profile it has already read
  // fills the fields at once.
  const profileQuery = useQuery({
    queryKey: profileQueryKey(user?.id),
    enabled: Boolean(user),
    queryFn: api.getProfile,
    staleTime: 1000 * 60 * 5,
  });
  // The fields follow the profile and the sign-in until the creator types.
  const [edits, setEdits] = useState<PublicIdentityDraft | null>(null);
  const [saveErrors, setSaveErrors] = useState<PublicIdentityErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Set by a press with something missing: until then the fields say nothing
  // about what has not been typed yet, as the composer's card does.
  const [pressed, setPressed] = useState(false);
  const identity = edits ?? getInitialPublicIdentity(profileQuery.data, user);
  const problems = validatePublicIdentity(identity, profileQuery.data?.username);

  // A save that is under way finishes, whatever is pressed meanwhile.
  const cancel = () => {
    if (!isSaving) onAnswer({ status: 'cancelled' });
  };
  // Dismissing by drag goes through the same handler as Cancel. The panel takes
  // a touch only once it is a pull, so the fields and the scroll view keep theirs.
  const drag = useSheetDismissDrag({ onDismiss: cancel, visible, takesTouchDown: false });
  const presentation = useSheetPresentation({ visible, reducedMotion, onExited });
  // An overlay is an ordinary view: unlike a Modal it has no native claim on
  // Android's back key, so it takes one.
  useHardwareBack(visible, cancel);

  // Closing puts the sheet's own keyboard away as the sheet leaves, rather
  // than after it has gone.
  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    if (wasVisibleRef.current === visible) return;
    wasVisibleRef.current = visible;
    Keyboard.dismiss();
  }, [visible]);

  const save = async () => {
    if (isSaving) return;
    setMessage(null);
    if (problems.displayName || problems.username) {
      setPressed(true);
      return;
    }
    setIsSaving(true);
    let saved: Awaited<ReturnType<typeof claimIdentity>>;
    try {
      // The composer's claim, with the same cache updates after it.
      saved = await claimIdentity(identity);
    } catch (error) {
      const { errors, message: saveMessage } = readPublicIdentitySaveError(error);
      setSaveErrors(errors);
      // A refusal on a field is said beside it; anything else above the fields.
      setMessage(errors.displayName || errors.username ? null : saveMessage);
      setIsSaving(false);
      return;
    }
    setIsSaving(false);
    onAnswer({ status: 'saved', profile: saved });
  };

  const motion = sheetMotion(drag, presentation);

  return (
    <Overlay visible={presentation.rendered}>
      {/* Answered once: while the exit plays the sheet is still drawn, and a press on it must not land. */}
      <View pointerEvents={visible ? 'auto' : 'none'} style={{ flex: 1 }}>
        {/* The area ends under the status bar, so a panel that gives up height to the keyboard keeps its title. */}
        <KeyboardAvoidingArea
          iosScrollViewAdjustsInsets
          followsKeyboard={presentation.settled}
          reservedBottomInset={bottomInset}
          testID="public-identity-keyboard-area"
          style={{ justifyContent: 'flex-end', paddingTop: insets.top + appTheme.spacing.panel }}
        >
          <SheetBackdrop drag={drag} style={motion.backdrop} onPress={cancel} />
          <SheetPanel
            {...drag.contentPanHandlers}
            accessibilityViewIsModal
            onLayout={presentation.onPanelLayout}
            style={[
              sheetPanelStyle(theme.colors),
              // The scroll view is what gives way when the keyboard squeezes the panel.
              { maxHeight: Math.min(height * 0.9, 640), flexShrink: 1, overflow: 'hidden' },
              motion.panel,
            ]}
          >
            <SheetGrabber drag={drag} />
            <ScrollView
              {...drag.scrollProps}
              automaticallyAdjustKeyboardInsets
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{
                gap: appTheme.spacing.card,
                paddingHorizontal: appTheme.spacing.panel,
                paddingBottom: Math.max(bottomInset, appTheme.spacing.panel),
              }}
            >
              <View style={{ gap: appTheme.spacing.compact }}>
                <AppText heading variant="sectionTitle">Add your name and handle</AppText>
                <AppText variant="bodySm" color="muted">
                  Public posts show both. They are saved to your profile, and you can change them there later.
                </AppText>
              </View>
              {message ? (
                <AppText accessibilityRole="alert" variant="bodySm" color="danger">{message}</AppText>
              ) : null}
              <PublicIdentityCard
                framed={false}
                value={identity}
                errors={{ ...(edits || pressed ? problems : {}), ...saveErrors }}
                editable={!isSaving}
                savedUsername={profileQuery.data?.username}
                onChange={(next) => {
                  setEdits(next);
                  setSaveErrors({});
                  setMessage(null);
                }}
              />
              <View style={{ gap: appTheme.spacing.compact }}>
                <PrimaryButton
                  label="Save and make public"
                  loading={isSaving}
                  loadingLabel="Saving…"
                  onPress={() => void save()}
                />
                <SecondaryButton label="Cancel" disabled={isSaving} onPress={cancel} />
              </View>
            </ScrollView>
          </SheetPanel>
        </KeyboardAvoidingArea>
      </View>
    </Overlay>
  );
}
