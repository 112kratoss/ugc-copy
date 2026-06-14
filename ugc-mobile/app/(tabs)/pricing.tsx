import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import type { PurchasesPackage } from 'react-native-purchases';

import { AppText, Card, MetricCard, Pill, PrimaryButton, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import {
  configureIapForUser,
  getCreditPackages,
  isIapConfigured,
  purchasePackage,
  resolveCreditEntitlement,
  restorePurchases,
} from '@/lib/iap';
import { MOBILE_PRICING_PLANS } from '@/lib/pricing';
import { appTheme } from '@/lib/theme';

function packageProductId(item: PurchasesPackage) {
  return item.product.identifier;
}

export default function PricingScreen() {
  const { user, api, credits, refreshProfile } = useAuth();
  const [isConfigured, setIsConfigured] = useState(false);
  const [busyProductId, setBusyProductId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const os = Platform.OS;

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

  const buyCredits = async (productId: string) => {
    if (!user) {
      router.push('/auth');
      return;
    }

    const nativePackage = packagesByProductId.get(productId);
    if (!nativePackage) {
      setNotice('Native purchase configuration is not ready for this product yet.');
      return;
    }

    setBusyProductId(productId);
    setNotice(null);
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
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Purchase could not be completed.');
    } finally {
      setBusyProductId(null);
    }
  };

  const storeLabel = os === 'ios' ? 'App Store' : os === 'android' ? 'Play Store' : 'Native only';

  const restore = async () => {
    if (!user) {
      router.push('/auth');
      return;
    }

    setBusyProductId('restore');
    setNotice(null);
    try {
      const customerInfo = isConfigured ? await restorePurchases() : null;
      await api.restoreMobilePurchases();
      await refreshProfile();
      setNotice(customerInfo ? 'Purchases restored and entitlements synced.' : 'Server-side entitlements refreshed.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Restore failed.');
    } finally {
      setBusyProductId(null);
    }
  };

  return (
    <Screen insideTab>
      <SectionTitle
        eyebrow="Pricing"
        title="Credits for mobile creation."
        body={`${credits ?? 0} credits available. Sign in before buying so RevenueCat purchases stay attached to your Magic Booklet account. Razorpay stays on web.`}
      />

      {!isIapConfigured(os) ? (
        <StatusBlock
          title="Native purchases need store keys"
          body="Set the RevenueCat public key for this platform before store purchases can run on-device."
        />
      ) : !user ? (
        <StatusBlock
          title="Sign in to buy credits"
          body="RevenueCat purchases are tied to your Magic Booklet account, so mobile credit packs unlock after you sign in."
        />
      ) : null}
      {packageQuery.error ? (
        <StatusBlock
          tone="danger"
          title="Could not load store products"
          body={packageQuery.error instanceof Error ? packageQuery.error.message : 'Try again.'}
        />
      ) : null}
      {notice ? <StatusBlock title="Purchase status" body={notice} /> : null}

      <View style={{ flexDirection: 'row', gap: appTheme.spacing.gap }}>
        <MetricCard
          label="Balance"
          value={String(credits ?? 0)}
          body="credits available"
          accent="amber"
          compact
        />
        <MetricCard
          label="Store"
          value={isConfigured ? 'Ready' : 'Setup'}
          body={storeLabel}
          accent={isConfigured ? 'workflow' : 'motion'}
          compact
        />
      </View>

      <View style={{ gap: 14 }}>
        {MOBILE_PRICING_PLANS.map((plan) => {
          const nativePackage = packagesByProductId.get(plan.productId);
          const price = nativePackage?.product.priceString ?? `Web equivalent Rs ${plan.webPriceInr}`;

          return (
            <Card key={plan.id} accent={plan.popular ? 'motion' : 'amber'}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: appTheme.spacing.gap }}>
                  <AppText variant="cardTitle">{plan.name}</AppText>
                  {plan.popular ? <Pill label="Popular" accent="motion" /> : null}
                </View>
                <AppText variant="sectionTitle" color="success" style={{ fontSize: 28, fontVariant: ['tabular-nums'] }}>
                  {plan.credits.toLocaleString()} credits
                </AppText>
                <AppText variant="bodySm" color="muted">{plan.description}</AppText>
                <AppText variant="label" color="faint">{price}</AppText>
              </View>
              <PrimaryButton
                label={busyProductId === plan.productId ? 'Processing...' : 'Buy with App Store / Play'}
                onPress={() => void buyCredits(plan.productId)}
                loading={busyProductId === plan.productId}
                disabled={!isConfigured || packageQuery.isLoading || !user}
                accent={plan.popular ? 'motion' : 'amber'}
              />
            </Card>
          );
        })}
      </View>

      <SecondaryButton
        label={busyProductId === 'restore' ? 'Restoring...' : 'Restore purchases'}
        onPress={() => void restore()}
        disabled={busyProductId === 'restore'}
      />
    </Screen>
  );
}
