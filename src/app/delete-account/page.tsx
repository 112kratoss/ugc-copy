import Link from 'next/link';

import { createMetadata, siteConfig } from '@/lib/seo';

export const metadata = createMetadata({
    title: 'Delete Your Account',
    description: `Learn how to permanently delete a ${siteConfig.name} account and the data associated with it.`,
    path: '/delete-account',
});

const deletionEmailSubject = encodeURIComponent('Magic Booklet account deletion request');
const deletionEmailBody = encodeURIComponent(
    'Please permanently delete my Magic Booklet account and associated personal data.\n\nAccount email: ',
);

export default function DeleteAccountPage() {
    return (
        <main className="min-h-screen bg-black px-6 py-16 text-white">
            <div className="mx-auto max-w-4xl">
                <p className="text-sm font-semibold uppercase tracking-[0.22em] text-rose-300">Account privacy</p>
                <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">Delete your Magic Booklet account</h1>
                <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-300">
                    You can permanently delete your account inside the Magic Booklet mobile app. If you cannot access
                    the app, you can send a deletion request from this page.
                </p>

                <div className="mt-10 grid gap-6 md:grid-cols-2">
                    <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-6">
                        <h2 className="text-xl font-semibold">Delete inside the app</h2>
                        <ol className="mt-4 list-decimal space-y-3 pl-5 text-zinc-300">
                            <li>Sign in to the Magic Booklet mobile app.</li>
                            <li>Open Profile, then Settings.</li>
                            <li>Select <strong className="text-white">Delete account</strong>.</li>
                            <li>Review what will be removed, type DELETE, and confirm permanent deletion.</li>
                        </ol>
                    </section>

                    <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-6">
                        <h2 className="text-xl font-semibold">Request deletion without the app</h2>
                        <p className="mt-4 leading-7 text-zinc-300">
                            Email us from the address connected to your account. We may ask you to verify ownership before
                            processing the request.
                        </p>
                        <a
                            className="mt-6 inline-flex min-h-12 items-center justify-center rounded-full bg-white px-5 py-3 font-semibold text-black transition hover:bg-zinc-200"
                            href={`mailto:${siteConfig.privacyEmail}?subject=${deletionEmailSubject}&body=${deletionEmailBody}`}
                        >
                            Request account deletion
                        </a>
                    </section>
                </div>

                <section className="mt-8 rounded-3xl border border-rose-400/20 bg-rose-400/[0.06] p-6">
                    <h2 className="text-xl font-semibold text-rose-200">What permanent deletion removes</h2>
                    <ul className="mt-4 list-disc space-y-2 pl-5 text-zinc-300">
                        <li>Your profile, authentication account, and sign-in identifiers (a one-way digest of those identifiers is kept — see below).</li>
                        <li>Your private creations, uploaded source media, saved items, templates, and account preferences.</li>
                        <li>Your remaining credits and purchase-linked access recorded on the account.</li>
                        <li>Push-notification tokens and other device associations connected to the account.</li>
                    </ul>
                </section>

                <section className="mt-8 rounded-3xl border border-white/10 bg-white/[0.04] p-6">
                    <h2 className="text-xl font-semibold">Data we may retain</h2>
                    <p className="mt-4 leading-7 text-zinc-300">
                        Records required for tax, accounting, fraud prevention, payment disputes, security, or other legal
                        obligations may be retained only for the period required by applicable law. These limited records
                        are isolated from the deleted account and are not used to keep the account active. Backup copies may
                        remain for a limited recovery cycle before being overwritten.
                    </p>
                    <p className="mt-4 leading-7 text-zinc-300">
                        To prevent repeat claims of one-time promotions, we also retain a one-way cryptographic digest of the
                        sign-in identifiers the deleted account used. The digest cannot be reversed into an email address or
                        identity, is not linked to the deleted account&apos;s content or activity, and is used only to detect
                        re-registration abuse of one-time offers.
                    </p>
                </section>

                <p className="mt-10 text-sm leading-6 text-zinc-400">
                    For more information, read our <Link className="text-white underline underline-offset-4" href="/privacy">Privacy Policy</Link>
                    {' '}or contact <a className="text-white underline underline-offset-4" href={`mailto:${siteConfig.privacyEmail}`}>{siteConfig.privacyEmail}</a>.
                </p>
            </div>
        </main>
    );
}
