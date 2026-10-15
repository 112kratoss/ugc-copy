import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { CheckCircle2, Circle } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { PurchasesPackage } from 'react-native-purchases';

import { AppText, Card, Kicker, Pill, PrimaryButton, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { GuestMergeBanner } from '@/components/guest-merge-banner';
import { acquireActivityLock } from '@/lib/app-activity';
import { useAuth } from '@/lib/auth';
import {
  canDeviceMakePayments,
  configureIapForUser,
  getCreditPackages,
  isIapConfigured,
  isUserCancelledPurchase,
  purchasePackage,
  resolveCreditEntitlement,
} from '@/lib/iap';
import { isPaymentPendingPurchase } from '@/lib/iap-purchase';
import {
  CHARGED_PURCHASE_LANDED_NOTICE,
  CHARGED_PURCHASE_NOT_LANDED_NOTICE,
  DEFAULT_MOBILE_PRICING_PLAN_ID,
  PAYMENT_PENDING_NOTICE,
  describeBalanceRefresh,
  describeRestoreOutcome,
  formatPricingDisplayPrice,
  getPricingPlanCarouselOffset,
  getPricingPlanIdForCarouselOffset,
  getPurchaseButtonLabel,
  purchaseSyncedNotice,
  resolvePurchaseGate,
  resolveSelectedPricingPlan,
  restoreFailedNotice,
  restoreLandedPurchase,
  type PricingNotice,
} from '@/lib/pricing-view-model';
import { CREDIT_BALANCE_LOADING_LABEL, MOBILE_PRICING_PLANS, formatCreditAmount, type MobilePricingPlan, type PricingPlanId } from '@/lib/pricing';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

function packageProductId(item: PurchasesPackage) {
  return item.product.identifier;
}

function PricingPlanCard({
  plan,
  price,
  selected,
  width,
  onPress,
}: {
  plan: MobilePricingPlan;
  price: string;
  selected: boolean;
  width: number;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  const SelectionIcon = selected ? CheckCircle2 : Circle;

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${plan.name}, ${formatCreditAmount(plan.credits)} credits, ${price}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        width,
        minHeight: 188,
        justifyContent: 'space-between',
        gap: appTheme.spacing.gap,
        borderWidth: 1,
        borderColor: selected ? `${theme.colors.commerce}88` : theme.colors.borderSubtle,
        borderRadius: appTheme.radii.xl,
        borderCurve: 'continuous',
        backgroundColor: selected ? `${theme.colors.commerce}16` : theme.colors.panel,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        padding: appTheme.spacing.card,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: appTheme.spacing.gap }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
          <AppText selectable={false} variant="label" color={selected ? 'commerce' : 'muted'}>
            {plan.name}
          </AppText>
          {plan.badge ? <Pill label={plan.badge} accent="commerce" style={{ minHeight: 28, paddingVertical: 4 }} /> : null}
        </View>
        <SelectionIcon
          color={selected ? theme.colors.commerce : theme.colors.faint}
          size={appTheme.icon.default}
        />
      </View>
      <View style={{ gap: appTheme.spacing.compact }}>
        <AppText
          selectable={false}
          variant="sectionTitle"
          style={{ fontSize: 28, fontVariant: ['tabular-nums'] }}
        >
          {formatCreditAmount(plan.credits)} credits
        </AppText>
        <AppText variant="bodySm" color="muted" numberOfLines={2}>
          {plan.description}
        </AppText>
      </View>
      <AppText
        variant="label"
        color={selected ? 'text' : 'textSecondary'}
        numberOfLines={1}
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {price}
      </AppText>
    </Pressable>
  );
}

export default function PricingScreen() {
  // `identityUserId` rather than `user`: this screen serves guests. A guest
  // holds a real backend identity, and credits are a server-side balance on it,
  // so everything here — store configuration, purchase, restore — keys off the
  // identity. `isGuest` only decides whether to offer registration.
  const { isGuest, identityUserId, api, credits, refreshProfile, ensureGuestMergeTicket } = useAuth();
  const queryClient = useQueryClient();
  const [isConfigured, setIsConfigured] = useState(false);
  const [paymentsAllowed, setPaymentsAllowed] = useState(true);
  const [busyProductId, setBusyProductId] = useState<string | null>(null);

  // A reload mid-purchase drops the flow between the store taking payment and
  // syncMobilePurchase recording it, which is the one window where a restart
  // can cost someone real money. Busy vetoes every OTA reload — see
  // lib/app-update-policy.
  useEffect(() => {
    if (!busyProductId) return;
    return acquireActivityLock('purchase');
  }, [busyProductId]);
  const [notice, setNotice] = useState<PricingNotice | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<PricingPlanId>(DEFAULT_MOBILE_PRICING_PLAN_ID);
  const carouselRef = useRef<ScrollView>(null);
  const { width: screenWidth } = useWindowDimensions();
  const os = Platform.OS;
  const carouselViewportWidth = Math.max(280, screenWidth - appTheme.spacing.screen * 2);
  const carouselPeek = appTheme.spacing.panel + appTheme.spacing.unit;
  const carouselCardWidth = Math.max(240, carouselViewportWidth - carouselPeek * 2);
  const carouselGap = appTheme.spacing.gap;
  const carouselSnapInterval = carouselCardWidth + carouselGap;

  useEffect(() => {
    let cancelled = false;

    async function syncIap() {
      if (os !== 'ios' && os !== 'android') {
        if (!cancelled) {
          setIsConfigured(false);
        }
        return;
      }

      if (!identityUserId) {
        if (!cancelled) {
          setIsConfigured(false);
        }
        return;
      }

      const ready = await configureIapForUser(identityUserId, os);
      if (!cancelled) {
        setIsConfigured(ready);
      }
      if (ready) {
        const allowed = await canDeviceMakePayments();
        if (!cancelled) {
          setPaymentsAllowed(allowed);
        }
      }
    }

    void syncIap();

    return () => {
      cancelled = true;
    };
  }, [os, identityUserId]);

  const packageQuery = useQuery({
    queryKey: ['iap-packages', os, identityUserId],
    enabled: isConfigured,
    queryFn: getCreditPackages,
  });

  const packagesByProductId = useMemo(() => {
    const entries = (packageQuery.data ?? []).map((item) => [packageProductId(item), item] as const);
    return new Map(entries);
  }, [packageQuery.data]);
  const storeReady = isConfigured
    && packageQuery.isSuccess
    && packagesByProductId.size > 0;
  const storeStatus = packageQuery.isLoading
    ? 'Connecting'
    : storeReady && paymentsAllowed
      ? 'Ready'
      : 'Unavailable';

  const selectedPlan = resolveSelectedPricingPlan(selectedPlanId);
  const selectedNativePackage = packagesByProductId.get(selectedPlan.productId);
  const selectedPrice = formatPricingDisplayPrice(selectedNativePackage?.product.priceString);
  const purchaseBusy = busyProductId === selectedPlan.productId;
  // The 5.1.1(v) rule, asserted in pricing-view-model.test.ts: purchase depends
  // on having a backend identity, not on being registered.
  const purchaseGate = resolvePurchaseGate({ identityUserId, isGuest, paymentsAllowed });
  const purchaseDisabled =
    !isConfigured
    || packageQuery.isLoading
    || !purchaseGate.canPurchase
    || !selectedNativePackage
    || busyProductId !== null;
  const selectedPackageUnavailable =
    isConfigured
    && Boolean(identityUserId)
    && packageQuery.isSuccess
    && !selectedNativePackage;
  const selectedPlanIndex = MOBILE_PRICING_PLANS.findIndex((plan) => plan.id === selectedPlan.id);

  const selectPlan = (planId: PricingPlanId) => {
    setSelectedPlanId(planId);
    carouselRef.current?.scrollTo({
      x: getPricingPlanCarouselOffset(planId, carouselSnapInterval),
      animated: true,
    });
  };

  const syncPlanFromCarousel = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setSelectedPlanId(getPricingPlanIdForCarouselOffset(
      event.nativeEvent.contentOffset.x,
      carouselSnapInterval
    ));
  };

  // The guest bootstrap is retried while the app runs (on a timer, and at once
  // on a return to the app), so there is nothing for the person to redo.
  const sessionStartingNotice: PricingNotice = {
    tone: 'neutral',
    title: 'Purchase status',
    body: 'Your session is still starting. The app keeps trying, and this screen updates by itself once it is ready.',
  };

  // A guest that has paid holds value on an identity only this device can
  // prove. The merge ticket is what carries it to an account registered later,
  // even if this guest session ends first.
  const keepGuestValue = () => {
    if (isGuest) void ensureGuestMergeTicket().catch(() => undefined);
  };

  const buyCredits = async (productId: string) => {
    // No sign-in gate. App Review rejected 0.0.5 (28) under guideline 5.1.1(v)
    // for exactly the bounce that used to be here. A guest already holds a
    // backend identity, so there is nothing to ask for before taking payment.
    if (!identityUserId) {
      setNotice(sessionStartingNotice);
      return;
    }

    const nativePackage = packagesByProductId.get(productId);
    if (!nativePackage) {
      setNotice({
        tone: 'danger',
        title: 'Purchase not completed',
        body: 'Native purchase configuration is not ready for this product yet.',
      });
      return;
    }

    setBusyProductId(productId);
    setNotice(null);
    // Read before the store sheet opens: a restore after a charge counts the
    // purchase as landed when the balance it reports has moved past this.
    const balanceBeforePurchase = credits;
    // Once the store returns, the money has moved. Nothing after that point may
    // tell the buyer their purchase failed.
    let charged = false;
    try {
      if (os !== 'ios' && os !== 'android') {
        throw new Error('Native purchases are only available on iOS and Android.');
      }

      // Resolved before charging: this used to throw 'Unknown credit product.'
      // *after* the store had already taken payment.
      const entitlement = resolveCreditEntitlement(productId);
      if (!entitlement || entitlement.type !== 'credits') {
        throw new Error('Unknown credit product.');
      }

      const purchase = await purchasePackage(nativePackage, os);
      // Set before anything reads the result: a result without a transaction
      // id is still a payment the store has taken.
      charged = true;
      if (!purchase.transactionId) {
        throw new Error('Purchase transaction is missing a store identifier.');
      }

      await api.syncMobilePurchase({
        provider: purchase.provider,
        productId: purchase.productId,
        transactionId: purchase.transactionId,
        entitlement,
      });
      await refreshProfile();
      setNotice(purchaseSyncedNotice(entitlement.credits));
    } catch (error) {
      if (isUserCancelledPurchase(error)) {
        setNotice(null);
      } else if (charged) {
        await recoverChargedPurchase(balanceBeforePurchase);
      } else if (isPaymentPendingPurchase(error)) {
        setNotice(PAYMENT_PENDING_NOTICE);
      } else {
        setNotice({
          tone: 'danger',
          title: 'Purchase not completed',
          body: error instanceof Error ? error.message : 'Purchase could not be completed.',
        });
      }
    } finally {
      setBusyProductId(null);
    }
    if (charged) keepGuestValue();
  };

  /**
   * The store charged the buyer but crediting the account did not land. Retry
   * through the restore path, which re-reads the purchase from the store, and
   * say it went through only when the restore settled it or the balance moved;
   * otherwise say plainly that the payment succeeded and the credits are on
   * their way — never that it failed.
   */
  const recoverChargedPurchase = async (balanceBeforePurchase: number | null) => {
    try {
      const restore = await api.restoreMobilePurchases();
      await refreshProfile();
      setNotice(restoreLandedPurchase(restore, balanceBeforePurchase)
        ? CHARGED_PURCHASE_LANDED_NOTICE
        : CHARGED_PURCHASE_NOT_LANDED_NOTICE);
    } catch {
      setNotice(CHARGED_PURCHASE_NOT_LANDED_NOTICE);
    }
  };

  const storeLabel = os === 'ios' ? 'App Store' : os === 'android' ? 'Play Store' : 'Native only';

  /**
   * A plain re-read of the balance. It used to run a full store restore, which
   * is rate limited, could fail the whole refresh on one conflicting purchase
   * and could send a "Purchase history refreshed" alert on every press.
   */
  const refreshBalance = async () => {
    if (!identityUserId) {
      setNotice(sessionStartingNotice);
      return;
    }

    setBusyProductId('refresh');
    setNotice(null);
    const pressedAt = Date.now();
    try {
      await refreshProfile();
    } catch {
      // Read from the profile query below like any other answer.
    } finally {
      setBusyProductId(null);
    }
    // refreshProfile() keeps its errors to itself; the profile query it
    // refreshes is where its answer lands.
    setNotice(describeBalanceRefresh(queryClient.getQueryState(['profile', identityUserId]), pressedAt));
  };

  /** Asks the store, through the server, for purchases that never reached the balance. */
  const restorePurchases = async () => {
    if (!identityUserId) {
      setNotice(sessionStartingNotice);
      return;
    }

    setBusyProductId('restore');
    setNotice(null);
    try {
      const restore = await api.restoreMobilePurchases();
      await refreshProfile();
      setNotice(describeRestoreOutcome(restore));
      if ((restore.restoredCreditPurchases ?? 0) > 0) keepGuestValue();
    } catch (error) {
      setNotice(restoreFailedNotice(error));
    } finally {
      setBusyProductId(null);
    }
  };

  return (
    <Screen insideTab>
      <SectionTitle
        eyebrow="Credits"
        title="Top up credits"
        body="One-time credit packs for image, video, and motion creation."
      />

      <Card accent="commerce" padding="sm">
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: appTheme.spacing.gap, padding: appTheme.spacing.compact }}>
          <View style={{ flex: 1, gap: 4 }}>
            <Kicker color="commerce">Available balance</Kicker>
            <AppText variant="sectionTitle" style={{ fontVariant: ['tabular-nums'] }}>
              {credits === null ? CREDIT_BALANCE_LOADING_LABEL : `${formatCreditAmount(credits)} credits`}
            </AppText>
          </View>
          <Pill
            label={`${storeLabel} · ${storeStatus}`}
            accent={storeReady ? 'workflow' : 'amber'}
          />
        </View>
      </Card>

      <GuestMergeBanner />

      {!isIapConfigured(os) ? (
        <StatusBlock
          title="Purchases are unavailable in this build"
          body="Your balance is safe. Update the app or try again later to buy a credit pack on this device."
        />
      ) : purchaseGate.blockedReason === 'payments_restricted' ? (
        // A confirmed canMakePayments() no — Screen Time or a device policy.
        // The HIG asks for explanatory UI instead of a store that cannot sell.
        <StatusBlock
          title="Purchases are turned off on this device"
          body="A device restriction such as Screen Time or parental controls is blocking payments here. Your balance and creations are not affected."
        />
      ) : purchaseGate.blockedReason === 'no_identity' ? (
        // The guest bootstrap has not landed (first launch, offline, anonymous
        // sign-ins off). Buy and Refresh are disabled, so say why on screen.
        <StatusBlock
          title="Your session is still starting"
          body="Credit packs unlock once your session is ready. The app keeps trying in the background, and this screen updates by itself."
        />
      ) : purchaseGate.showRegistrationOffer ? (
        // Offered, never required. This is the shape guideline 5.1.1(v) asks
        // for in as many words: "You may explain to the user that registering
        // will enable them to access the purchased content from any of their
        // supported devices and provide them a way to register at any time."
        // The buy buttons below stay live whether or not this is acted on.
        <View style={{ gap: appTheme.spacing.gap }}>
          <StatusBlock
            title="Buy now, create an account whenever you like"
            body="Your credits and creations stay on this device. Creating a free account protects them and lets you reach them from any device."
          />
          <SecondaryButton
            label="Create an account to sync"
            onPress={() => router.push({
              pathname: '/auth',
              params: { mode: 'signup', returnTo: '/(tabs)/pricing' },
            } as never)}
          />
        </View>
      ) : null}
      {packageQuery.error ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          <StatusBlock
            tone="danger"
            title="Credit packs are not available"
            body={`The ${storeLabel} could not return this build's credit packs. Retry once; if this continues, the purchase setup needs an app update.`}
          />
          <SecondaryButton label="Retry credit packs" onPress={() => void packageQuery.refetch()} />
        </View>
      ) : null}
      {notice ? <StatusBlock tone={notice.tone} title={notice.title} body={notice.body} /> : null}
      {selectedPackageUnavailable ? (
        <StatusBlock
          title="This credit pack is not available"
          body="Choose another pack or try again after the store finishes updating."
        />
      ) : null}

      <View style={{ gap: appTheme.spacing.gap }}>
        {purchaseGate.blockedReason !== 'payments_restricted' ? (<>
        <View style={{ gap: appTheme.spacing.compact }}>
          <Kicker>Choose a pack</Kicker>
          <ScrollView
            ref={carouselRef}
            horizontal
            accessibilityLabel="Credit pack carousel"
            showsHorizontalScrollIndicator={false}
            decelerationRate="fast"
            disableIntervalMomentum
            snapToInterval={carouselSnapInterval}
            snapToAlignment="start"
            contentOffset={{
              x: getPricingPlanCarouselOffset(DEFAULT_MOBILE_PRICING_PLAN_ID, carouselSnapInterval),
              y: 0,
            }}
            contentContainerStyle={{
              gap: carouselGap,
              paddingHorizontal: carouselPeek,
            }}
            onLayout={() => {
              carouselRef.current?.scrollTo({
                x: getPricingPlanCarouselOffset(selectedPlan.id, carouselSnapInterval),
                animated: false,
              });
            }}
            onMomentumScrollEnd={syncPlanFromCarousel}
          >
            {MOBILE_PRICING_PLANS.map((plan) => (
              <PricingPlanCard
                key={plan.id}
                plan={plan}
                price={formatPricingDisplayPrice(packagesByProductId.get(plan.productId)?.product.priceString)}
                selected={plan.id === selectedPlanId}
                width={carouselCardWidth}
                onPress={() => selectPlan(plan.id)}
              />
            ))}
          </ScrollView>
          <AppText
            selectable={false}
            variant="caption"
            color="faint"
            style={{ alignSelf: 'center', fontVariant: ['tabular-nums'] }}
          >
            {selectedPlan.name} - {selectedPlanIndex + 1} of {MOBILE_PRICING_PLANS.length}
          </AppText>
        </View>

        <PrimaryButton
          label={getPurchaseButtonLabel({
            plan: selectedPlan,
            price: selectedPrice,
            loading: packageQuery.isLoading,
            processing: purchaseBusy,
          })}
          onPress={() => void buyCredits(selectedPlan.productId)}
          loading={purchaseBusy}
          disabled={purchaseDisabled}
          accent="primary"
        />
        </>) : null}
        <SecondaryButton
          label={busyProductId === 'refresh' ? 'Refreshing…' : 'Refresh credit balance'}
          onPress={() => void refreshBalance()}
          disabled={!identityUserId || busyProductId !== null}
          accessibilityHint="Reads your Magicbooklet credit balance again"
        />
        <SecondaryButton
          label={busyProductId === 'restore' ? 'Restoring…' : 'Restore purchases'}
          onPress={() => void restorePurchases()}
          disabled={!identityUserId || busyProductId !== null}
          accessibilityHint={`Checks your ${storeLabel} purchases for credits that have not reached your balance`}
        />
      </View>
    </Screen>
  );
}
