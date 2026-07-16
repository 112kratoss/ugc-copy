import LoginClient from '@/app/login/LoginClient';
import { getSafeAuthNextPath } from '@/lib/auth-onboarding';

interface LoginPageProps {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
    const params = searchParams ? await searchParams : {};
    const explicitRedirect = firstParam(params.next)
        || firstParam(params.redirect)
        || firstParam(params.returnUrl);

    return (
        <LoginClient
            initialMode={firstParam(params.mode) === 'signup' ? 'signup' : 'login'}
            recoveryRequested={firstParam(params.recovery) === '1'}
            redirectTo={getSafeAuthNextPath(explicitRedirect)}
        />
    );
}
