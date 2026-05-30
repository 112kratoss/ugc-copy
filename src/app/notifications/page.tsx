'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Bell,
  CheckCheck,
  CheckCircle2,
  Clock,
  CreditCard,
  Heart,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

interface WebNotification {
  id: string;
  type: string;
  category: 'generation' | 'commerce' | 'social' | 'system';
  title: string;
  body: string;
  deepLink: string;
  isRead: boolean;
  createdAt: string;
  updatedAt: string;
}

const CATEGORY_META = {
  generation: { color: 'text-violet-400 border-violet-500/20 bg-violet-500/10', Icon: Sparkles, label: 'Generation' },
  commerce: { color: 'text-amber-400 border-amber-500/20 bg-amber-500/10', Icon: CreditCard, label: 'Unlocks' },
  social: { color: 'text-rose-400 border-rose-500/20 bg-rose-500/10', Icon: Heart, label: 'Creator' },
  system: { color: 'text-cyan-400 border-cyan-500/20 bg-cyan-500/10', Icon: Bell, label: 'System' },
};

export default function NotificationsPage() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<WebNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [, startTransition] = useTransition();

  const fetchNotifications = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setIsAuthenticated(false);
        setLoading(false);
        return;
      }
      setIsAuthenticated(true);

      const response = await fetch('/api/mobile/notifications?limit=50');
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setNotifications(data.notifications || []);
          setUnreadCount(data.unreadCount || 0);
        }
      }
    } catch (error) {
      console.error('Failed to load notifications:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNotifications();

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        setIsAuthenticated(true);
        fetchNotifications();
      } else {
        setIsAuthenticated(false);
        setNotifications([]);
        setUnreadCount(0);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const handleMarkAllRead = async () => {
    if (unreadCount === 0) return;
    try {
      const response = await fetch('/api/mobile/notifications/read-all', {
        method: 'POST',
      });
      if (response.ok) {
        setNotifications((current) =>
          current.map((n) => ({ ...n, isRead: true }))
        );
        setUnreadCount(0);
      }
    } catch (error) {
      console.error('Failed to mark all read:', error);
    }
  };

  const handlePressNotification = async (notification: WebNotification) => {
    if (!notification.isRead) {
      try {
        const response = await fetch('/api/mobile/notifications/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [notification.id] }),
        });
        if (response.ok) {
          setNotifications((current) =>
            current.map((n) => (n.id === notification.id ? { ...n, isRead: true } : n))
          );
          setUnreadCount((prev) => Math.max(0, prev - 1));
        }
      } catch (error) {
        console.error('Failed to mark notification read:', error);
      }
    }

    // Convert deepLink from mobile format (e.g. /viewer?...) or handle accordingly
    if (notification.deepLink) {
      startTransition(() => {
        router.push(notification.deepLink);
      });
    }
  };

  const formatTime = (value: string) => {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return 'Just now';
    const diffMs = Date.now() - timestamp;
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (diffMs < minute) return 'Just now';
    if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
    if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
    return `${Math.floor(diffMs / day)}d ago`;
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-white">Notifications</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {isAuthenticated
              ? `${unreadCount} unread ${unreadCount === 1 ? 'alert' : 'alerts'}`
              : 'Sign in to view alerts'}
          </p>
        </div>

        {isAuthenticated && (
          <div className="flex gap-2">
            <button
              onClick={fetchNotifications}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
              title="Refresh alerts"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              onClick={handleMarkAllRead}
              disabled={unreadCount === 0}
              className="inline-flex h-10 gap-2 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] px-4 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              <CheckCheck className="h-4 w-4" />
              <span>Mark all read</span>
            </button>
          </div>
        )}
      </div>

      {!isAuthenticated ? (
        <div className="rounded-3xl border border-white/10 bg-[#10111a] p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-zinc-400">
            <Bell className="h-6 w-6" />
          </div>
          <h3 className="mt-4 text-lg font-semibold text-white">Sign in required</h3>
          <p className="mt-2 text-sm text-zinc-400">
            Sign in to review generation results, unlocks, follows, saves, remixes, and creator activity.
          </p>
          <Link
            href="/login"
            className="mt-6 inline-flex items-center justify-center rounded-full bg-blue-500 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-400"
          >
            Sign in
          </Link>
        </div>
      ) : loading ? (
        <div className="flex min-h-[240px] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
        </div>
      ) : notifications.length > 0 ? (
        <div className="space-y-3">
          {notifications.map((notification) => {
            const meta = CATEGORY_META[notification.category] || CATEGORY_META.system;
            const Icon = meta.Icon;

            return (
              <div
                key={notification.id}
                onClick={() => handlePressNotification(notification)}
                className={`flex cursor-pointer items-start gap-4 rounded-2xl border p-4 transition ${
                  notification.isRead
                    ? 'border-white/10 bg-zinc-950/40 hover:bg-zinc-900/40'
                    : 'border-violet-500/30 bg-violet-500/[0.04] hover:bg-violet-500/[0.07]'
                }`}
              >
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${meta.color}`}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-semibold text-white text-sm sm:text-base leading-tight">
                      {notification.title}
                    </h3>
                    {!notification.isRead && (
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-violet-500 shadow-[0_0_8px_#8b5cf6]" />
                    )}
                  </div>
                  <p className="mt-1 text-xs sm:text-sm leading-relaxed text-zinc-400">
                    {notification.body}
                  </p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-3">
                    <span className="inline-flex items-center rounded-full bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-zinc-300">
                      {meta.label}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500 font-medium">
                      <Clock className="h-3 w-3" />
                      {formatTime(notification.createdAt)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-3xl border border-white/10 bg-[#10111a] p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <h3 className="mt-4 text-lg font-semibold text-white">You are all caught up</h3>
          <p className="mt-2 text-sm text-zinc-400">
            New alerts appear here with unread status, categories, and direct links to the relevant features.
          </p>
        </div>
      )}
    </div>
  );
}
