'use client';

import { useEffect, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';

import { onCreditTopUpOpen, type CreditTopUpNeed, type CreditTopUpRequest } from '@/lib/credit-top-up';

type CreditTopUpPanelComponent = ComponentType<{ need: CreditTopUpNeed; pricingHref: string; onClose: () => void }>;

/**
 * Holds the top-up sheet for the page it is drawn on, closed until something on the page asks
 * for it (`openCreditTopUp`): the creators draw one, so a short balance buys credits where the
 * run is set up instead of leaving it (owner, 2026-11-02). The packs and their checkout
 * (`CreditTopUpPanel`) load the first time they are asked for, so a creator's page carries no
 * payment code until then; a load that fails goes to the pricing page instead.
 */
export function CreditTopUpHost() {
  // Undefined while closed.
  const [request, setRequest] = useState<CreditTopUpRequest | undefined>(undefined);
  const [Panel, setPanel] = useState<CreditTopUpPanelComponent | null>(null);
  useEffect(() => onCreditTopUpOpen((next) => {
    setRequest(next);
    void import('@/components/CreditTopUpPanel').then(
      (module) => setPanel(() => module.CreditTopUpPanel),
      () => window.location.assign(new URL(next.pricingHref, window.location.origin)),
    );
  }), []);
  if (!request || !Panel || typeof document === 'undefined') return null;
  return createPortal(
    <Panel need={request.need} pricingHref={request.pricingHref} onClose={() => setRequest(undefined)} />,
    document.body,
  );
}
