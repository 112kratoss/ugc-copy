import { useQuery } from '@tanstack/react-query';
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
import { useAuth } from '@/lib/auth';
import {
  configureIapForUser,
  getCreditPackages,
  isIapConfigured,
  purchasePackage,
  resolveCreditEntitlement,
} from '@/lib/iap';
import {
  DEFAULT_MOBILE_PRICING_PLAN_ID,
  formatPricingDisplayPrice,
  getPricingPlanCarouselOffset,
  getPricingPlanIdForCarouselOffset,
  getPurchaseButtonLabel,
  resolveSelectedPricingPlan,
} from '@/lib/pricing-view-model';
import { MOBILE_PRICING_PLANS, type MobilePricingPlan, type PricingPlanId } from '@/lib/pricing';
import { appTheme } from '@/lib/theme';

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
  const SelectionIcon = selected ? CheckCircle2 : Circle;

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${plan.name}, ${plan.credits.toLocaleString('en-IN')} credits, ${price}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        width,
        minHeight: 188,
        justifyContent: 'space-between',
        gap: appTheme.spacing.gap,
        borderWidth: 1,
        borderColor: selected ? `${appTheme.colors.commerce}88` : appTheme.colors.borderSubtle,
        borderRadius: appTheme.radii.xl,
        borderCurve: 'continuous',
        backgroundColor: selected ? `${appTheme.colors.commerce}16` : appTheme.colors.panel,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        padding: appTheme.spacing.card,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: appTheme.spacing.gap }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
          <AppText selectable={false} variant="label" color={selected ? 'commerce' : 'muted'}>
            {plan.name}
          </AppText>
          {plan.popular ? <Pill label="Popular" accent="commerce" style={{ minHeight: 28, paddingVertical: 4 }} /> : null}
        </View>
        <SelectionIcon
          color={selected ? appTheme.colors.commerce : appTheme.colors.faint}
          size={appTheme.icon.default}
          strokeWidth={selected ? 2.5 : 2}
        />
      </View>
      <View style={{ gap: appTheme.spacing.compact }}>
        <AppText
          selectable={false}
          variant="sectionTitle"
          style={{ fontSize: 28, fontVariant: ['tabular-nums'] }}
        >
          {plan.credits.toLocaleString('en-IN')} credits
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
  const { user, api, credits, refreshProfile } = useAuth();
  const [isConfigured, setIsConfigured] = useState(false);
  const [busyProductId, setBusyProductId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<'success' | 'danger' | 'neutral'>('neutral');
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

      if (!user?.id) {
        if (!cancelled) {
          setIsConfigured(false);
        }
        return;
      }

      const ready = await configureIapForUser(user.id, os);
      if (!cancelled) {
        setIsConfigured(ready);
      }
    }

    void syncIap();

    return () => {
      cancelled = true;
    };
  }, [os, user?.id]);

  const packageQuery = useQuery({
    queryKey: ['iap-packages', os, user?.id],
    enabled: isConfigured,
    queryFn: getCreditPackages,
  });

  const packagesByProductId = useMemo(() => {
    const entries = (packageQuery.data ?? []).map((item) => [packageProductId(item), item] as const);
    return new Map(entries);
  }, [packageQuery.data]);

  const selectedPlan = resolveSelectedPricingPlan(selectedPlanId);
  const selectedNativePackage = packagesByProductId.get(selectedPlan.productId);
  const selectedPrice = formatPricingDisplayPrice(
    selectedPlan,
    selectedNativePackage?.product.priceString
  );
  const purchaseBusy = busyProductId === selectedPlan.productId;
  const purchaseDisabled =
    !isConfigured
    || packageQuery.isLoading
    || !user
    || !selectedNativePackage
    || busyProductId !== null;
  const selectedPackageUnavailable =
    isConfigured
    && Boolean(user)
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

  const buyCredits = async (productId: string) => {
    if (!user) {
      router.push('/auth');
      return;
    }

    const nativePackage = packagesByProductId.get(productId);
    if (!nativePackage) {
      setNotice('Native purchase configuration is not ready for this product yet.');
      setNoticeTone('danger');
      return;
    }

    setBusyProductId(productId);
    setNotice(null);
    setNoticeTone('neutral');
    try {
      if (os !== 'ios' && os !== 'android') {
        throw new Error('Native purchases are only available on iOS and Android.');
      }

      const purchase = await purchasePackage(nativePackage, os);
      const entitlement = resolveCreditEntitlement(productId);
      if (!entitlement || entitlement.type !== 'credits') {
        throw new Error('Unknown credit product.');
      }

      await api.syncMobilePurchase({
        provider: purchase.provider,
        productId: purchase.productId,
        transactionId: purchase.transactionId,
        entitlement,
      });
      await refreshProfile();
      setNotice(`${entitlement.credits} credits are synced to your account.`);
      setNoticeTone('success');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Purchase could not be completed.');
      setNoticeTone('danger');
    } finally {
      setBusyProductId(null);
    }
  };

  const storeLabel = os === 'ios' ? 'App Store' : os === 'android' ? 'Play Store' : 'Native only';

  const refreshBalance = async () => {
    if (!user) {
      router.push('/auth');
      return;
    }

    setBusyProductId('restore');
    setNotice(null);
    setNoticeTone('neutral');
    try {
      await api.restoreMobilePurchases();
      await refreshProfile();
      setNotice('Your credit balance was refreshed from your Magic Booklet purchase history.');
      setNoticeTone('success');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Credit balance refresh failed.');
      setNoticeTone('danger');
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
              {(credits ?? 0).toLocaleString('en-IN')} credits
            </AppText>
          </View>
          <Pill
            label={`${storeLabel} · ${isConfigured ? 'Ready' : 'Unavailable'}`}
            accent={isConfigured ? 'workflow' : 'amber'}
          />
        </View>
      </Card>

      {!isIapConfigured(os) ? (
        <StatusBlock
          title="Purchases are unavailable in this build"
          body="Your balance is safe. Update the app or try again later to buy a credit pack on this device."
        />
      ) : !user ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          <StatusBlock
            title="Sign in to buy credits"
            body="Credit packs are tied to your Magicbooklet account and sync across devices."
          />
          <PrimaryButton
            label="Sign in to continue"
            onPress={() => router.push('/auth' as never)}
            accent="primary"
          />
        </View>
      ) : null}
      {packageQuery.error ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          <StatusBlock tone="danger" title="Could not load credit packs" body="Check your connection, then try again." />
          <SecondaryButton label="Retry credit packs" onPress={() => void packageQuery.refetch()} />
        </View>
      ) : null}
      {notice ? <StatusBlock tone={noticeTone} title={noticeTone === 'success' ? 'Purchase updated' : noticeTone === 'danger' ? 'Purchase not completed' : 'Purchase status'} body={notice} /> : null}
      {selectedPackageUnavailable ? (
        <StatusBlock
          title="This credit pack is not available"
          body="Choose another pack or try again after the store finishes updating."
        />
      ) : null}

      <View style={{ gap: appTheme.spacing.gap }}>
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
                price={formatPricingDisplayPrice(
                  plan,
                  packagesByProductId.get(plan.productId)?.product.priceString
                )}
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
        <SecondaryButton
          label={busyProductId === 'restore' ? 'Refreshing...' : 'Refresh credit balance'}
          onPress={() => void refreshBalance()}
          disabled={!user || busyProductId !== null}
          accessibilityHint="Checks your Magic Booklet account for previously credited purchases without opening the App Store restore flow"
        />
      </View>
    </Screen>
  );
}
