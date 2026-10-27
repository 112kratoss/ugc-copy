import { permanentRedirect } from 'next/navigation';

type FeedPageProps = {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * The standalone feed was Home's feed again, with nothing in the app linking
 * to it: an old address goes to Home, on the lane it named (`?chip=`).
 */
export default async function FeedPage({ searchParams }: FeedPageProps) {
    const chip = (await searchParams)?.chip;
    const lane = Array.isArray(chip) ? chip[0] : chip;
    permanentRedirect(lane ? `/?${new URLSearchParams({ chip: lane })}` : '/');
}
