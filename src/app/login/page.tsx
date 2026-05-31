'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { ArrowLeft, Loader2, Mail, Lock, AlertCircle, Eye, EyeOff, CheckCircle2 } from 'lucide-react';

function getSafeRedirectPath(value: string | null, fallback = '/profile') {
    if (!value) {
        return fallback;
    }

    try {
        const decoded = decodeURIComponent(value);
        if (decoded.startsWith('/') && !decoded.startsWith('//') && !decoded.includes('\\')) {
            return decoded;
        }
    } catch {
        if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) {
            return value;
        }
    }

    return fallback;
}

function getConfiguredAuthOrigin() {
    const configuredOrigin =
        process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN ||
        process.env.NEXT_PUBLIC_SITE_URL;

    if (configuredOrigin) {
        try {
            const parsed = new URL(configuredOrigin);
            const isSecure = parsed.protocol === 'https:';
            const isLocal =
                parsed.protocol === 'http:' &&
                (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');

            if (isSecure || isLocal) {
                return parsed.origin;
            }
        } catch {
            // Fall through to the active browser origin.
        }
    }

    return window.location.origin;
}

function getAuthCallbackUrl(nextPath: string) {
    return `${getConfiguredAuthOrigin()}/auth/callback?next=${encodeURIComponent(nextPath)}`;
}

const PROFILE_SETUP_REDIRECT = '/profile?welcome=1';

export default function LoginPage() {
    return (
        <Suspense fallback={
            <div className="min-h-screen bg-black text-white flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-purple-400" />
            </div>
        }>
            <LoginContent />
        </Suspense>
    );
}

function LoginContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const explicitRedirect = searchParams.get('redirect') || searchParams.get('returnUrl');
    const redirectTo = getSafeRedirectPath(explicitRedirect, PROFILE_SETUP_REDIRECT);
    const signupRedirectTo = PROFILE_SETUP_REDIRECT;
    const [isLogin, setIsLogin] = useState(true);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);

    useEffect(() => {
        let isActive = true;

        supabase.auth.getSession().then(({ data }) => {
            if (!isActive || !data.session) {
                return;
            }

            router.replace(redirectTo);
            router.refresh();
        });

        return () => {
            isActive = false;
        };
    }, [redirectTo, router]);

    const handleAuth = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setSuccessMessage(null);

        try {
            if (isLogin) {
                const { error } = await supabase.auth.signInWithPassword({
                    email,
                    password,
                });
                if (error) throw error;
                router.replace(redirectTo);
                router.refresh();
            } else {
                const { data, error } = await supabase.auth.signUp({
                    email,
                    password,
                    options: {
                        emailRedirectTo: getAuthCallbackUrl(signupRedirectTo),
                    },
                });
                if (error) throw error;
                if (data.session) {
                    router.replace(signupRedirectTo);
                    router.refresh();
                    return;
                }
                // Check if email confirmation is required based on project settings
                setSuccessMessage('Check your email for the confirmation link. It will open your creator profile setup automatically.');
                setIsLogin(true); // Switch to login mode
                setLoading(false); // Stop loading since we're just showing a message
                return;
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'An error occurred';
            setError(message);
        } finally {
            if (isLogin) setLoading(false);
        }
    };

    const handleGoogleLogin = async () => {
        setLoading(true);
        setError(null);
        setSuccessMessage(null);
        try {
            const nextPath = isLogin ? redirectTo : signupRedirectTo;
            const { error } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: getAuthCallbackUrl(nextPath),
                },
            });
            if (error) throw error;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'An error occurred';
            setError(message);
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-black text-white flex flex-col p-6">
            <Link
                href="/"
                className="inline-flex items-center gap-2 text-zinc-400 hover:text-white transition-colors mb-8 w-fit"
            >
                <ArrowLeft className="w-4 h-4" />
                Back to Home
            </Link>

            <div className="flex-1 flex items-center justify-center">
                <div className="w-full max-w-md">
                    <div className="text-center mb-8">
                        <h1 className="text-3xl font-bold mb-2">
                            {isLogin ? 'Welcome Back' : 'Create Account'}
                        </h1>
                        <p className="text-zinc-400">
                            {isLogin
                                ? 'Enter your details to access your account'
                                : 'Start creating viral AI videos today'}
                        </p>
                    </div>

                    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8">
                        <form onSubmit={handleAuth} className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-zinc-400 mb-1.5">
                                    Email Address
                                </label>
                                <div className="relative">
                                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500" />
                                    <input
                                        type="email"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        required
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-3 pl-10 pr-4 text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-all placeholder:text-zinc-600"
                                        placeholder="name@example.com"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-zinc-400 mb-1.5">
                                    Password
                                </label>
                                <div className="relative">
                                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500" />
                                    <input
                                        type={showPassword ? 'text' : 'password'}
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        required
                                        minLength={6}
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-3 pl-10 pr-12 text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-all placeholder:text-zinc-600"
                                        placeholder="••••••••"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword((current) => !current)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-500 transition-colors hover:text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                                    >
                                        {showPassword ? (
                                            <EyeOff className="w-5 h-5" />
                                        ) : (
                                            <Eye className="w-5 h-5" />
                                        )}
                                    </button>
                                </div>
                            </div>

                            {error && (
                                <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-red-500 text-sm">
                                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                                    <p>{error}</p>
                                </div>
                            )}

                            {successMessage && (
                                <div className="flex items-start gap-3 rounded-lg border border-emerald-400/20 bg-emerald-500/10 p-3 text-sm text-emerald-100">
                                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
                                    <p>{successMessage}</p>
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full bg-white text-black font-semibold py-3 rounded-lg hover:bg-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                            >
                                {loading ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Processing...
                                    </>
                                ) : (
                                    isLogin ? 'Sign In' : 'Create Account'
                                )}
                            </button>
                        </form>

                        <div className="relative my-8">
                            <div className="absolute inset-0 flex items-center">
                                <div className="w-full border-t border-zinc-800"></div>
                            </div>
                            <div className="relative flex justify-center text-sm">
                                <span className="px-2 bg-zinc-900 text-zinc-500">Or continue with</span>
                            </div>
                        </div>

                        <button
                            onClick={handleGoogleLogin}
                            disabled={loading}
                            className="w-full bg-zinc-950 border border-zinc-800 text-white font-medium py-3 rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            <svg className="w-5 h-5" viewBox="0 0 24 24">
                                <path
                                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                                    fill="#4285F4"
                                />
                                <path
                                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                                    fill="#34A853"
                                />
                                <path
                                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                                    fill="#FBBC05"
                                />
                                <path
                                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                                    fill="#EA4335"
                                />
                            </svg>
                            Google
                        </button>

                        <p className="mt-8 text-center text-sm text-zinc-400">
                            {isLogin ? "Don't have an account? " : "Already have an account? "}
                            <button
                                onClick={() => {
                                    setIsLogin(!isLogin);
                                    setError(null);
                                    setSuccessMessage(null);
                                }}
                                className="text-white hover:underline font-medium"
                            >
                                {isLogin ? 'Sign up' : 'Log in'}
                            </button>
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
