import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import {
  BadgeCheck,
  ChevronRight,
  CircleHelp,
  Crown,
  LayoutDashboard,
  LogIn,
  LogOut,
  Settings,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react-native';
import { Modal, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { User } from '@supabase/supabase-js';

import type { ProfileResponse } from '@/lib/types';
import { formatUsdCents } from '@/lib/home-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { appTheme } from '@/lib/theme';

interface HomeSideMenuProps {
  visible: boolean;
  onClose: () => void;
  user: User | null;
  profile: ProfileResponse | null | undefined;
  credits: number;
  totalSalesUsdCents: number;
  totalSalesLoading: boolean;
  onSignOut: () => Promise<void>;
}

export function HomeSideMenu({
  visible,
  onClose,
  user,
  profile,
  credits,
  totalSalesUsdCents,
  totalSalesLoading,
  onSignOut,
}: HomeSideMenuProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const drawerWidth = Math.min(width * 0.78, 340);
  const displayName =
    profile?.displayName?.trim() ||
    user?.user_metadata?.full_name ||
    user?.email?.split('@')[0] ||
    'Guest creator';
  const handle = profile?.username?.trim() ? `@${profile.username}` : user?.email ?? 'Sign in to sync your account';
  const initial = displayName.trim().charAt(0).toUpperCase() || 'A';

  const navigateAndClose = (path: string) => {
    onClose();
    router.push(path as never);
  };

  const handleAuthPress = async () => {
    onClose();
    if (user) {
      await onSignOut();
      return;
    }
    router.push('/auth' as never);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.62)' }}>
        <View
          style={{
            width: drawerWidth,
            paddingTop: topInset + 16,
            paddingBottom: bottomInset + 16,
            paddingHorizontal: 16,
            backgroundColor: 'rgba(4,5,16,0.96)',
            borderRightWidth: 1,
            borderRightColor: 'rgba(168,85,247,0.24)',
            boxShadow: '18px 0 54px rgba(0,0,0,0.52)',
          }}
        >
          <LinearGradient
            colors={['rgba(217,70,239,0.22)', 'rgba(14,165,233,0.1)', 'rgba(3,4,13,0)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ pointerEvents: 'none', position: 'absolute', left: 0, right: 0, top: 0, height: 230 }}
          />
          <View style={{ flex: 1, gap: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, flex: 1, minWidth: 0 }}>
                <Sparkles size={26} color="#d946ef" fill="rgba(217,70,239,0.22)" />
                <Text numberOfLines={1} style={{ color: '#fff', fontSize: 21, fontWeight: '900', flexShrink: 1 }}>
                  Magic Booklet
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close menu"
                onPress={onClose}
                style={({ pressed }) => ({
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'rgba(255,255,255,0.08)',
                  opacity: pressed ? 0.72 : 1,
                })}
              >
                <X size={20} color="#ffffff" />
              </Pressable>
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open profile"
              onPress={() => navigateAndClose('/profile')}
              style={({ pressed }) => ({
                borderRadius: 24,
                borderCurve: 'continuous',
                overflow: 'hidden',
                opacity: pressed ? 0.84 : 1,
              })}
            >
              <BlurView intensity={26} tint="dark" style={{ borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', backgroundColor: 'rgba(255,255,255,0.06)', padding: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ width: 54, height: 54, borderRadius: 27, overflow: 'hidden', backgroundColor: 'rgba(124,58,237,0.42)', alignItems: 'center', justifyContent: 'center' }}>
                    {profile?.avatarUrl ? (
                      <Image source={{ uri: profile.avatarUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
                    ) : (
                      <Text style={{ color: '#fff', fontSize: 21, fontWeight: '900' }}>{initial}</Text>
                    )}
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text numberOfLines={1} style={{ color: '#fff', fontSize: 17, fontWeight: '900', flexShrink: 1 }}>
                        {displayName}
                      </Text>
                      {user ? <BadgeCheck size={17} color="#a855f7" fill="#7c3cff" /> : null}
                    </View>
                    <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 13, fontWeight: '600' }}>
                      {handle}
                    </Text>
                  </View>
                  <ChevronRight size={19} color="rgba(255,255,255,0.72)" />
                </View>
              </BlurView>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open credits"
              onPress={() => navigateAndClose('/pricing')}
              style={({ pressed }) => ({
                borderRadius: 22,
                overflow: 'hidden',
                opacity: pressed ? 0.82 : 1,
              })}
            >
              <LinearGradient
                colors={['rgba(91,33,182,0.42)', 'rgba(217,70,239,0.16)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{ minHeight: 66, borderRadius: 22, borderWidth: 1, borderColor: 'rgba(168,85,247,0.34)', paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11, minWidth: 0, flex: 1 }}>
                  <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(251,191,36,0.14)' }}>
                    <Crown size={22} color="#fbbf24" fill="rgba(251,191,36,0.22)" />
                  </View>
                  <View style={{ gap: 2, minWidth: 0, flex: 1 }}>
                    <Text style={{ color: '#fff', fontSize: 19, fontWeight: '900', fontVariant: ['tabular-nums'] }}>{credits} Credits</Text>
                    <Text style={{ color: appTheme.colors.muted, fontSize: 12, fontWeight: '700' }}>Buy more</Text>
                  </View>
                </View>
                <ChevronRight size={19} color="rgba(255,255,255,0.72)" />
              </LinearGradient>
            </Pressable>

            <View
              style={{
                borderRadius: 22,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor: 'rgba(34,211,238,0.22)',
                backgroundColor: 'rgba(6,182,212,0.08)',
                padding: 15,
                gap: 10,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(34,211,238,0.12)' }}>
                  <Wallet size={21} color="#22d3ee" />
                </View>
                <View style={{ gap: 2, minWidth: 0, flex: 1 }}>
                  <Text style={{ color: appTheme.colors.muted, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 }}>Total sales</Text>
                  <Text style={{ color: '#fff', fontSize: 24, fontWeight: '900', fontVariant: ['tabular-nums'] }}>
                    {totalSalesLoading ? 'Loading...' : formatUsdCents(totalSalesUsdCents)}
                  </Text>
                </View>
              </View>
            </View>

            <View style={{ gap: 9 }}>
              <MenuRow icon={<LayoutDashboard size={21} color="#ffffff" />} label="Seller Dashboard" onPress={() => navigateAndClose('/seller-dashboard')} />
              <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginVertical: 5 }} />
              <MenuRow icon={<Settings size={21} color="#ffffff" />} label="Settings" onPress={() => navigateAndClose('/settings')} />
              <MenuRow icon={<CircleHelp size={21} color="#ffffff" />} label="Help & Support" onPress={() => navigateAndClose('/help')} />
            </View>

            <View style={{ flex: 1 }} />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={user ? 'Sign out' : 'Sign in'}
              onPress={() => void handleAuthPress()}
              style={({ pressed }) => ({
                minHeight: 52,
                borderRadius: 18,
                borderCurve: 'continuous',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                backgroundColor: user ? 'rgba(248,113,113,0.12)' : 'rgba(168,85,247,0.22)',
                borderWidth: 1,
                borderColor: user ? 'rgba(248,113,113,0.28)' : 'rgba(168,85,247,0.34)',
                opacity: pressed ? 0.78 : 1,
              })}
            >
              {user ? <LogOut size={20} color="#fecaca" /> : <LogIn size={20} color="#ffffff" />}
              <Text style={{ color: user ? '#fecaca' : '#fff', fontSize: 15, fontWeight: '900' }}>{user ? 'Sign out' : 'Sign in'}</Text>
            </Pressable>
          </View>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Close menu" onPress={onClose} style={{ flex: 1 }} />
      </View>
    </Modal>
  );
}

function MenuRow({
  icon,
  label,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 52,
        borderRadius: 17,
        borderCurve: 'continuous',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 13,
        backgroundColor: pressed ? 'rgba(168,85,247,0.16)' : 'rgba(255,255,255,0.055)',
        opacity: pressed ? 0.86 : 1,
      })}
    >
      <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)' }}>
        {icon}
      </View>
      <Text numberOfLines={1} style={{ flex: 1, color: '#ffffff', fontSize: 15, fontWeight: '800' }}>
        {label}
      </Text>
      <ChevronRight size={18} color="rgba(255,255,255,0.58)" />
    </Pressable>
  );
}
