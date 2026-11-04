import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LandlordAPI, type BetaView } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import FoundingAgreementDialog from '../../components/landlord/FoundingAgreementDialog';

// One source of truth for a landlord's free beta and founding offer.
//
// It used to live inside the banner, which meant the sidebar could not know a
// landlord had just accepted, and the offer could only be opened from the
// banner. Lifted here so that the sidebar's "Founding Landlord" label, the
// banner, the pinned bell row and the Wallet page all read the same state, and
// all open the SAME single dialog -- accepting or declining updates every one of
// them at once, with no reload.
//
// ONE CHEAP READ on mount (GET /landlords/beta, no ?highlights). The proof
// numbers are the dialog's business, fetched only when a person opens it.
//
// THE FIRST-PAINT HINT. The sidebar says "Founding Landlord" only after that
// read returns, which would flash "Property Owner" on every page load for a
// founding landlord. So whether this person is founding is remembered in
// localStorage, per user, and used until the server answers -- never trusted
// past it: the server's answer always replaces it. Storage can be missing or
// throw (private windows), so every access is wrapped and the worst case is the
// brief flash we are avoiding.

export type FoundingHint = { since: string | null };

type BetaStatus = {
  /** null until the first read returns, or if it failed (then nothing renders). */
  beta: BetaView | null;
  loaded: boolean;
  /** Replace the state with what the server just said (accept / decline). */
  setBeta: (view: BetaView) => void;
  /** Open the founding-offer dialog from anywhere. */
  openOffer: () => void;
  /** Present when this landlord has accepted -- from the server, or the hint. */
  founding: FoundingHint | null;
};

const NOOP_STATUS: BetaStatus = {
  beta: null,
  loaded: false,
  setBeta: () => {},
  openOffer: () => {},
  founding: null,
};

const BetaStatusContext = createContext<BetaStatus | null>(null);

const hintKey = (userId: string) => `artrelo:founding:${userId}`;

function readHint(userId: string | undefined): FoundingHint | null {
  if (!userId) return null;
  try {
    const raw = window.localStorage.getItem(hintKey(userId));
    return raw ? (JSON.parse(raw) as FoundingHint) : null;
  } catch {
    return null;
  }
}

function writeHint(userId: string | undefined, hint: FoundingHint | null) {
  if (!userId) return;
  try {
    if (hint) window.localStorage.setItem(hintKey(userId), JSON.stringify(hint));
    else window.localStorage.removeItem(hintKey(userId));
  } catch {
    // No storage: the label may flash on the next load. Acceptable.
  }
}

export function BetaStatusProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  const [beta, setBetaState] = useState<BetaView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [hint, setHint] = useState<FoundingHint | null>(() => readHint(userId));
  const [searchParams, setSearchParams] = useSearchParams();

  // A different person signing in on the same browser starts from their own hint.
  useEffect(() => {
    setHint(readHint(userId));
  }, [userId]);

  const apply = useCallback(
    (view: BetaView) => {
      setBetaState(view);
      const next = view.founding ? { since: view.foundingSince } : null;
      setHint(next);
      writeHint(userId, next);
    },
    [userId]
  );

  useEffect(() => {
    let cancelled = false;
    LandlordAPI.getBeta()
      .then((view) => {
        if (!cancelled) apply(view);
      })
      // A banner or a label is never worth an error toast. No beta info -> none.
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  // The reminder email and the in-app notification both link to
  // /dashboard?founding=1: open the offer, then clear the parameter so a
  // refresh does not reopen it. Only once the state is known, so that an
  // already-answered offer shows its true state rather than a flash of "open".
  const wantsOffer = searchParams.get('founding') === '1';
  useEffect(() => {
    if (!wantsOffer || !beta) return;
    setDialogOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('founding');
    setSearchParams(next, { replace: true });
  }, [wantsOffer, beta, searchParams, setSearchParams]);

  const openOffer = useCallback(() => setDialogOpen(true), []);

  const value = useMemo<BetaStatus>(
    () => ({
      beta,
      loaded,
      setBeta: apply,
      openOffer,
      // The server's word once we have it; the hint only until then.
      founding: loaded && beta ? (beta.founding ? { since: beta.foundingSince } : null) : hint,
    }),
    [beta, loaded, apply, openOffer, hint]
  );

  return (
    <BetaStatusContext.Provider value={value}>
      {children}
      <FoundingAgreementDialog open={dialogOpen} onOpenChange={setDialogOpen} onChange={apply} />
    </BetaStatusContext.Provider>
  );
}

/**
 * Read the beta/offer state. Outside the provider (a page rendered on its own,
 * a test) it returns an inert value rather than throwing: nothing founding is
 * shown and `openOffer` does nothing.
 */
export function useBetaStatus(): BetaStatus {
  return useContext(BetaStatusContext) ?? NOOP_STATUS;
}
