import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { AUTH_SESSION_EXPIRED_EVENT, getStoredUser } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { irisApi } from './irisApi';
import { availablePageWidth, DOCK, dockLayout, scrollbarAllowance, type DockLayout } from './irisDock';
import { irisIdentityKey, sameIdentity } from './irisIdentity';
import { IrisController, type IrisState } from './irisController';
import { keepsPanelOpen } from './irisRoutes';

interface IrisContextValue {
  controller: IrisController;
  state: IrisState;
  openPanel: () => void;
  closePanel: () => void;
  /** Follow an in-panel link: View Policy keeps the panel open, Open Requests closes it. */
  follow: (href: string) => void;
  /** Where focus goes when the panel closes: the visible launcher, or the new page's heading. */
  takeCloseFocus: () => 'launcher' | 'heading';
  /** Wide screens dock the panel beside the page; otherwise it is a modal sheet. */
  dock: DockLayout;
  setPanelWidth: (width: number) => void;
  /** The shell's page column, measured to decide whether the panel fits beside it. */
  mainRef: RefObject<HTMLElement | null>;
  /**
   * The unsent message, kept here so switching between docked and sheet (or
   * closing and reopening on the same page) keeps it. `epoch` is the
   * controller's draftEpoch it was typed in: any other context discards it.
   */
  draft: IrisDraft;
}

export interface IrisDraft {
  current: string;
  epoch: number;
}

const IrisContext = createContext<IrisContextValue | null>(null);

const EMPTY = new IrisController({} as never).getState();

/**
 * One Iris for the whole signed-in landlord shell. Mounted in LandlordShell,
 * so it survives every child navigation; keyed by the signed-in identity, so a
 * different account never sees the previous one's conversation.
 */
export function IrisProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  // Account, role and sign-in email: a change to any of them is a new identity.
  const identity = irisIdentityKey(user);
  const [controller, setController] = useState<IrisController | null>(null);
  // Memory only: survives child navigation, resets with the identity below.
  const [requestedWidth, setRequestedWidth] = useState<number>(DOCK.defaultWidth);
  const draft = useRef<IrisDraft>({ current: '', epoch: -1 });

  useEffect(() => {
    if (!identity) return undefined;
    // Checked before every call: another tab signing in as someone else (or
    // as this account's other role) stops this controller at once.
    const next = new IrisController(irisApi, { isSignedIn: () => sameIdentity(identity, getStoredUser()) });
    setController(next);
    setRequestedWidth(DOCK.defaultWidth);
    draft.current = { current: '', epoch: -1 };
    // Session expiry is a window event; sign Iris out in the same dispatch,
    // before React re-renders anything.
    const expire = () => {
      draft.current.current = '';
      next.signOut();
    };
    // A sign-in or sign-out in another tab rewrites the stored session.
    const storageChanged = (event: StorageEvent) => {
      if (event.storageArea === localStorage && !sameIdentity(identity, getStoredUser())) {
        draft.current.current = '';
        next.signOut();
      }
    };
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expire);
    window.addEventListener('storage', storageChanged);
    return () => {
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expire);
      window.removeEventListener('storage', storageChanged);
      next.signOut();
    };
  }, [identity]);

  // The provider sits above the matched child route, so the child's useParams
  // cannot be read here; match the location instead. Query tabs are ignored.
  const match = useMatch('/dashboard/requests/:id');
  const requestId = match?.params.id ?? null;
  useEffect(() => {
    controller?.setRoute(requestId);
  }, [controller, requestId]);

  useEffect(() => {
    if (!controller) return undefined;
    const sync = () => controller.setPaused(document.visibilityState === 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [controller]);

  useEffect(() => {
    if (!controller) return undefined;
    const hide = () => controller.pagehide();
    const show = (event: PageTransitionEvent) => controller.pageshow(event.persisted);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, [controller]);

  const subscribe = useCallback((fn: () => void) => (controller ? controller.subscribe(fn) : () => {}), [controller]);
  const getSnapshot = useCallback(() => (controller ? controller.getState() : EMPTY), [controller]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Measured from the page column's margin and padding, which docking never
  // changes, so the decision cannot flip itself.
  const mainRef = useRef<HTMLElement | null>(null);
  const [available, setAvailable] = useState(Number.NaN);
  useEffect(() => {
    const measure = () => setAvailable(availablePageWidth(mainRef.current, window.innerWidth - scrollbarAllowance()));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [controller]);
  const dock = useMemo(() => dockLayout(available, requestedWidth), [available, requestedWidth]);

  const navigate = useNavigate();
  const closeFocus = useRef<'launcher' | 'heading'>('launcher');

  const value = useMemo<IrisContextValue | null>(() => {
    if (!controller) return null;
    return {
      controller,
      state,
      openPanel: () => {
        closeFocus.current = 'launcher';
        void controller.open();
      },
      closePanel: () => controller.close(),
      follow: (href) => {
        if (keepsPanelOpen(href)) {
          navigate(href);
          return;
        }
        closeFocus.current = 'heading';
        controller.close();
        navigate(href);
      },
      takeCloseFocus: () => {
        const target = closeFocus.current;
        closeFocus.current = 'launcher';
        return target;
      },
      dock,
      setPanelWidth: setRequestedWidth,
      mainRef,
      draft: draft.current,
    };
  }, [controller, state, navigate, dock]);

  return <IrisContext.Provider value={value}>{children}</IrisContext.Provider>;
}

/** Null outside the landlord shell, or before the controller exists. */
export function useIris() {
  return useContext(IrisContext);
}
