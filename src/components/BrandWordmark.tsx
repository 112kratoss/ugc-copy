import clsx from 'clsx';
import { Sparkles } from 'lucide-react';

import { displayFont } from '@/lib/display-font';

/**
 * The product's name as the app's lockup draws it (`BrandLockup` in `ugc-mobile/components/ui.tsx`):
 * a coral sparkle, then the name in the text colour around it, in the app's display face. The web
 * spells it in two words (#697), so it reads and copies as "Magic Booklet". The coral "Magic" and
 * lavender "booklet" belong to the first sign-up's note alone.
 *
 * Sized by the text size it is given (`className`, e.g. `text-[40px]`): the sparkle and the gap are
 * in `em`, so one class scales the whole lockup. The sparkle is decoration and the name is the text,
 * so a heading the wordmark finishes ("Start filling your Magic Booklet") reads whole.
 */
export default function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-[0.22em] whitespace-nowrap font-extrabold', displayFont.className, className)}>
      <Sparkles aria-hidden data-brand-sparkle="" className="h-[0.86em] w-[0.86em] shrink-0 text-[var(--ui-primary)]" strokeWidth={2.2} />
      <span>Magic Booklet</span>
    </span>
  );
}
