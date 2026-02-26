'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export default function AuthCodeErrorPage() {
    return (
        <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6">
            <div className="max-w-md text-center">
                <h1 className="text-3xl font-bold mb-4">Authentication Error</h1>
                <p className="text-zinc-400 mb-8">
                    Something went wrong during the sign-in process. This can happen if the link expired or was already used. Please try signing in again.
                </p>
                <Link
                    href="/login"
                    className="inline-flex items-center gap-2 bg-white text-black px-6 py-3 rounded-full font-medium hover:bg-zinc-200 transition-colors"
                >
                    <ArrowLeft className="w-4 h-4" />
                    Back to Login
                </Link>
            </div>
        </div>
    );
}
