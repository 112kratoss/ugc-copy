'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { ArrowLeft, Loader2, Mail, Lock, AlertCircle, Eye, EyeOff, CheckCircle2, WandSparkles } from 'lucide-react';
import { buildAuthContinuePath } from '@/lib/auth-onboarding';
import {
    getPasswordRequirements,
    getPasswordValidationMessage,
} from '@/lib/password-policy';

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

type AuthErrorField = 'email' | 'password' | 'confirmPassword' | null;

export interface LoginClientProps {
    initialMode: 'login' | 'signup';
    recoveryRequested: boolean;
    redirectTo: string;
}

export default function LoginClient({
    initialMode,
    recoveryRequested,
    redirectTo,
}: LoginClientProps) {
    const router = useRouter();
    const signupRedirectTo = buildAuthContinuePath(redirectTo);
    const [isLogin, setIsLogin] = useState(initialMode !== 'signup');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errorField, setErrorField] = useState<AuthErrorField>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(
        recoveryRequested
            ? 'Enter your email, then choose Forgot password to request a fresh recovery link.'
            : null
    );
    const emailRef = useRef<HTMLInputElement>(null);
    const passwordRef = useRef<HTMLInputElement>(null);
    const confirmPasswordRef = useRef<HTMLInputElement>(null);
    const passwordRequirements = getPasswordRequirements(password);

    useEffect(() => {
        let isActive = true;

        supabase.auth.getSession().then(({ data }) => {
            if (!isActive || !data.session) {
                return;
            }

            router.replace(buildAuthContinuePath(redirectTo));
            router.refresh();
        });

        return () => {
            isActive = false;
        };
    }, [redirectTo, router]);

    const handleAuth = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setErrorField(null);
        setSuccessMessage(null);

        if (!isLogin) {
            const passwordError = getPasswordValidationMessage(password);
            if (passwordError) {
                setError(passwordError);
                setErrorField('password');
                passwordRef.current?.focus();
                return;
            }

            if (password !== confirmPassword) {
                setError('The passwords do not match. Re-enter the same password.');
                setErrorField('confirmPassword');
                confirmPasswordRef.current?.focus();
                return;
            }
        }

        setLoading(true);

        try {
            if (isLogin) {
                const { error } = await supabase.auth.signInWithPassword({
                    email,
                    password,
                });
                if (error) throw error;
                router.replace(buildAuthContinuePath(redirectTo));
                router.refresh();
            } else {
                const { data, error } = await supabase.auth.signUp({
                    email,
                    password,
                    options: {
                        emailRedirectTo: getAuthCallbackUrl(redirectTo),
                    },
                });
                if (error) throw error;
                if (data.session) {
                    router.replace(signupRedirectTo);
                    router.refresh();
                    return;
                }
                setSuccessMessage('Check your email for the confirmation link. We’ll help you finish your profile, then continue where you left off.');
                setIsLogin(true);
                setPassword('');
                setConfirmPassword('');
                setLoading(false);
                return;
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'An error occurred';
            setError(message);
        } finally {
            setLoading(false);
        }
    };

    const handleSocialLogin = async () => {
        setLoading(true);
        setError(null);
        setErrorField(null);
        setSuccessMessage(null);
        try {
            const { error } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: getAuthCallbackUrl(redirectTo),
                },
            });
            if (error) throw error;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'An error occurred';
            setError(message);
            setLoading(false);
        }
    };

    const handlePasswordReset = async () => {
        if (!email.trim()) {
            setError('Enter your email address first, then choose Forgot password.');
            setErrorField('email');
            emailRef.current?.focus();
            return;
        }

        setLoading(true);
        setError(null);
        setErrorField(null);
        setSuccessMessage(null);

        try {
            const resetPage = `/auth/reset-password?next=${encodeURIComponent(redirectTo)}`;
            const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
                redirectTo: getAuthCallbackUrl(resetPage),
            });
            if (resetError) throw resetError;
            setSuccessMessage('Password reset link sent. Check your email to continue.');
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Could not send the reset link.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="ui-page ui-page-ambient flex min-h-screen flex-col p-4 sm:p-6">
            <div className="flex items-center justify-between gap-4">
                <Link
                    href="/"
                    prefetch={false}
                    className="ui-focus-ring inline-flex min-h-12 w-fit items-center gap-2 rounded-full px-3 text-sm font-bold text-[var(--ui-text-muted)] transition hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
                >
                    <ArrowLeft className="h-4 w-4" aria-hidden />
                    Back home
                </Link>
                <Link href="/" prefetch={false} className="ui-focus-ring flex items-center gap-2 rounded-xl text-[var(--ui-text-primary)]">
                    <span className="flex h-9 w-9 items-center justify-center rounded-[13px] bg-[var(--ui-primary)] text-[var(--ui-primary-on)]">
                        <WandSparkles className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="hidden text-sm font-extrabold sm:inline">magicbooklet</span>
                </Link>
            </div>

            <div className="flex-1 flex items-center justify-center">
                <div className="w-full max-w-md">
                    <div className="mb-7 text-center">
                        <h1 className="mb-2 text-3xl font-extrabold tracking-tight text-[var(--ui-text-primary)]">
                            {isLogin ? 'Welcome back' : 'Create your account'}
                        </h1>
                        <p className="text-sm leading-6 text-[var(--ui-text-muted)]">
                            {isLogin
                                ? 'Sign in to continue to your creator workspace.'
                                : 'Create an account now. Your creator profile comes next.'}
                        </p>
                    </div>

                    <div className="rounded-[28px] border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-6 shadow-[var(--ui-shadow-panel)] sm:p-8">
                        <div className="mb-6 grid grid-cols-2 rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] p-1" role="group" aria-label="Choose authentication mode">
                            <button
                                type="button"
                                aria-pressed={isLogin}
                                onClick={() => {
                                    setIsLogin(true);
                                    setError(null);
                                    setErrorField(null);
                                    setSuccessMessage(null);
                                    setConfirmPassword('');
                                }}
                                className={`ui-focus-ring min-h-11 rounded-xl px-3 text-sm font-extrabold transition ${
                                    isLogin
                                        ? 'bg-[var(--ui-surface-3)] text-[var(--ui-text-primary)] shadow-sm'
                                        : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
                                }`}
                            >
                                Sign in
                            </button>
                            <button
                                type="button"
                                aria-pressed={!isLogin}
                                onClick={() => {
                                    setIsLogin(false);
                                    setError(null);
                                    setErrorField(null);
                                    setSuccessMessage(null);
                                }}
                                className={`ui-focus-ring min-h-11 rounded-xl px-3 text-sm font-extrabold transition ${
                                    !isLogin
                                        ? 'bg-[var(--ui-primary)] text-[var(--ui-primary-on)] shadow-sm'
                                        : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
                                }`}
                            >
                                Sign up
                            </button>
                        </div>

                        <form onSubmit={handleAuth} className="space-y-4">
                            <div>
                                <label htmlFor="login-email" className="mb-1.5 block text-sm font-bold text-[var(--ui-text-secondary)]">
                                    Email address
                                </label>
                                <div className="relative">
                                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500" />
                                    <input
                                        id="login-email"
                                        ref={emailRef}
                                        name="email"
                                        type="email"
                                        value={email}
                                        onChange={(e) => {
                                            setEmail(e.target.value);
                                            if (errorField === 'email') {
                                                setError(null);
                                                setErrorField(null);
                                            }
                                        }}
                                        required
                                        autoComplete="email"
                                        aria-invalid={errorField === 'email'}
                                        aria-describedby={errorField === 'email' ? 'auth-error' : undefined}
                                        className="ui-focus-ring w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] py-3 pl-10 pr-4 text-[var(--ui-text-primary)] outline-none transition placeholder:text-[var(--ui-text-faint)] focus:border-[var(--ui-focus)]"
                                        placeholder="name@example.com"
                                    />
                                </div>
                            </div>

                            <div>
                                <div className="mb-1.5 flex items-center justify-between gap-3">
                                    <label htmlFor="login-password" className="block text-sm font-bold text-[var(--ui-text-secondary)]">
                                        Password
                                    </label>
                                    {isLogin ? (
                                        <button
                                            type="button"
                                            onClick={() => void handlePasswordReset()}
                                            disabled={loading}
                                            className="ui-focus-ring rounded-full px-2 py-1 text-xs font-bold text-[var(--ui-primary)] hover:bg-[var(--ui-primary-soft)] disabled:opacity-50"
                                        >
                                            Forgot password?
                                        </button>
                                    ) : null}
                                </div>
                                <div className="relative">
                                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500" />
                                    <input
                                        id="login-password"
                                        ref={passwordRef}
                                        name="password"
                                        type={showPassword ? 'text' : 'password'}
                                        value={password}
                                        onChange={(e) => {
                                            setPassword(e.target.value);
                                            if (errorField === 'password') {
                                                setError(null);
                                                setErrorField(null);
                                            }
                                        }}
                                        required
                                        minLength={isLogin ? undefined : 8}
                                        autoComplete={isLogin ? 'current-password' : 'new-password'}
                                        aria-invalid={errorField === 'password'}
                                        aria-describedby={[
                                            !isLogin ? 'signup-password-requirements' : null,
                                            errorField === 'password' ? 'auth-error' : null,
                                        ].filter(Boolean).join(' ') || undefined}
                                        className="ui-focus-ring w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] py-3 pl-10 pr-12 text-[var(--ui-text-primary)] outline-none transition placeholder:text-[var(--ui-text-faint)] focus:border-[var(--ui-focus)]"
                                        placeholder="••••••••"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword((current) => !current)}
                                        className="ui-focus-ring absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-[var(--ui-text-faint)] transition hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
                                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                                    >
                                        {showPassword ? (
                                            <EyeOff className="w-5 h-5" />
                                        ) : (
                                            <Eye className="w-5 h-5" />
                                        )}
                                    </button>
                                </div>

                                {!isLogin ? (
                                    <div id="signup-password-requirements" className="mt-3 rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-3">
                                        <p className="text-xs font-bold text-[var(--ui-text-secondary)]">Your password needs:</p>
                                        <ul className="mt-2 grid gap-1.5 text-xs sm:grid-cols-2">
                                            {passwordRequirements.map((requirement) => (
                                                <li
                                                    key={requirement.id}
                                                    className={`flex items-center gap-2 ${
                                                        requirement.isMet ? 'text-emerald-300' : 'text-[var(--ui-text-faint)]'
                                                    }`}
                                                >
                                                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                                    {requirement.label}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                ) : null}
                            </div>

                            {!isLogin ? (
                                <div>
                                    <label htmlFor="confirm-password" className="mb-1.5 block text-sm font-bold text-[var(--ui-text-secondary)]">
                                        Confirm password
                                    </label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-500" aria-hidden />
                                        <input
                                            id="confirm-password"
                                            ref={confirmPasswordRef}
                                            name="confirmPassword"
                                            type={showPassword ? 'text' : 'password'}
                                            value={confirmPassword}
                                            onChange={(event) => {
                                                setConfirmPassword(event.target.value);
                                                if (errorField === 'confirmPassword') {
                                                    setError(null);
                                                    setErrorField(null);
                                                }
                                            }}
                                            required
                                            minLength={8}
                                            autoComplete="new-password"
                                            aria-invalid={errorField === 'confirmPassword'}
                                            aria-describedby={errorField === 'confirmPassword' ? 'auth-error' : undefined}
                                            className="ui-focus-ring w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] py-3 pl-10 pr-4 text-[var(--ui-text-primary)] outline-none transition focus:border-[var(--ui-focus)]"
                                            placeholder="Re-enter your password"
                                        />
                                    </div>
                                </div>
                            ) : null}

                            {error && (
                                <div id="auth-error" role="alert" aria-live="assertive" className="flex items-start gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
                                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                                    <p>{error}</p>
                                </div>
                            )}

                            {successMessage && (
                                <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-3 text-sm text-emerald-100">
                                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
                                    <p>{successMessage}</p>
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={loading}
                                className="ui-focus-ring flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-4 font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {loading ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Processing...
                                    </>
                                ) : (
                                    isLogin ? 'Sign in' : 'Create account'
                                )}
                            </button>
                        </form>

                        <div className="relative my-8">
                            <div className="absolute inset-0 flex items-center">
                                <div className="w-full border-t border-[var(--ui-border-subtle)]"></div>
                            </div>
                            <div className="relative flex justify-center text-sm">
                                <span className="bg-[var(--ui-surface-1)] px-2 text-[var(--ui-text-faint)]">Or continue with</span>
                            </div>
                        </div>

                        <div>
                            <button
                                type="button"
                                onClick={() => void handleSocialLogin()}
                                disabled={loading}
                                className="ui-focus-ring flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 font-bold text-[var(--ui-text-primary)] transition hover:bg-[var(--ui-surface-2)] disabled:opacity-50"
                            >
                                <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
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
                                Continue with Google
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            <footer className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs font-semibold text-[var(--ui-text-faint)]">
                <Link href="/privacy" prefetch={false} className="hover:text-[var(--ui-text-primary)]">Privacy</Link>
                <Link href="/terms" prefetch={false} className="hover:text-[var(--ui-text-primary)]">Terms</Link>
                <Link href="/contact" prefetch={false} className="hover:text-[var(--ui-text-primary)]">Contact</Link>
            </footer>
        </div>
    );
}
