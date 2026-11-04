// Centralized API client for Artrelo frontend.
// All paths are relative to VITE_API_URL (default "/api/v1").

import type {
  DeletionCheck,
  PortfolioBatchResult,
  PortfolioImported,
  Property,
  RoutingDecisionItem,
  TenantMoveOutStatus,
  UnitBatchCreated,
  UnitBatchResult,
} from '../types/landlord';
import type {
  CreationEligibility,
  IntakeDetailsSubmission,
  IntakeMode,
  SafetyReviewDisposition,
} from '../types/requestWorkflow';

import type { IrisActivityList, IrisRequestActivity } from '../types/irisActivity';
import type { ItemizationInput, QuoteSnapshot } from '../lib/itemization';
import { scopeReviewReopenBody, type QuoteReviews, type ScopeReviewReopenInput, type ScopeReviewReopenReceipt, type ScopeReviewStage } from '../lib/costReview';

/** GET /vendor-portal/:token/quote-clarification. No token, hash of the link,
 *  or internal cost ceiling is ever part of it. */
export interface QuoteClarificationData {
  stage: 'quote' | 'invoice';
  quoteRevision: number;
  quoteHash: string;
  expiresAt: string;
  questions: { id: string; code: string; lineIds: string[]; text: string }[];
  quote: QuoteSnapshot | null;
  allowRevision: boolean;
}

/** Only the parameters that are set; an opaque cursor is passed through untouched. */
function irisActivityQuery(params: { limit?: number; cursor?: string | null; activeOnly?: boolean }) {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.activeOnly) qs.set('activeOnly', 'true');
  const text = qs.toString();
  return text ? `?${text}` : '';
}

export type PortfolioImportPayload = {
  name: string;
  address: string;
  units: { name: string }[];
};

const BASE = (import.meta as { env: { VITE_API_URL?: string } }).env.VITE_API_URL || '/api/v1';

export type ApiEnvelope<T = unknown> = {
  success: boolean;
  message?: string;
  data?: T;
  // Legacy fields some endpoints use
  user?: unknown;
  token?: string;
  refreshToken?: string;
  triageReceipt?: string | null;
  signupToken?: string;
};

const USER_KEY = 'ronarai_user';
export const AUTH_SESSION_EXPIRED_EVENT = 'ronarai:auth-session-expired';
let accessTokenMemory: string | null = null;

let refreshPromise: Promise<boolean> | null = null;

export function getToken(): string | null {
  return accessTokenMemory;
}

export function setToken(token: string | null) {
  accessTokenMemory = token || null;
}

export function getStoredUser<U = unknown>(): U | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as U;
  } catch {
    return null;
  }
}

export function setStoredUser(user: unknown | null) {
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(USER_KEY);
}

export function clearStoredSession() {
  setToken(null);
  setStoredUser(null);
}

function notifySessionExpired() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
  }
}

export class ApiError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

export async function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
  try {
    const res = await fetch(`${BASE}/auth/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({}),
    });

    const payload = (await res.json().catch(() => ({}))) as ApiEnvelope<{ token?: string }>;
    if (!res.ok || !payload.token) {
      clearStoredSession();
      notifySessionExpired();
      return false;
    }

    // The refreshed session must be the one this tab thinks it has.
    //
    // A browser holds ONE refresh cookie. Someone holding both a landlord and
    // a tenant profile who signs in as the other role in a second tab
    // overwrites it, and this tab's next refresh would quietly hand back the
    // other role's token — every call from here on returning 403 with no
    // explanation. Ending the session says what actually happened.
    const refreshed = (payload as { user?: { role?: string } }).user;
    const stored = getStoredUser<{ role?: string }>();
    if (refreshed?.role && stored?.role && refreshed.role !== stored.role) {
      clearStoredSession();
      notifySessionExpired();
      return false;
    }

    setToken(payload.token);
    return true;
  } catch {
    clearStoredSession();
    notifySessionExpired();
    return false;
  } finally {
    refreshPromise = null;
  }
  })();

  return refreshPromise;
}

async function request<T = unknown>(
  path: string,
  options: RequestInit & { auth?: boolean; refresh?: boolean } = {}
): Promise<ApiEnvelope<T>> {
  // FormData must NOT get an explicit Content-Type: only the browser can append
  // the multipart boundary, and setting it by hand yields a body the server
  // cannot parse.
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers as Record<string, string>),
  };
  const useAuth = options.auth !== false;

  const execute = async (token?: string | null) => {
    const nextHeaders: Record<string, string> = { ...headers };
    if (useAuth) {
      const currentToken = token ?? getToken();
      if (currentToken) nextHeaders['Authorization'] = `Bearer ${currentToken}`;
    }

    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: nextHeaders,
      credentials: 'include',
    });

    let payload: ApiEnvelope<T> = {} as ApiEnvelope<T>;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try {
        payload = (await res.json()) as ApiEnvelope<T>;
      } catch {
        payload = {} as ApiEnvelope<T>;
      }
    }

    return { res, payload };
  };

  let { res, payload } = await execute();

  // refresh: false (an unload keepalive) never renews the session: a 401 is final.
  if (useAuth && options.refresh !== false && res.status === 401 && path !== '/auth/refresh-token') {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      ({ res, payload } = await execute());
    }
  }

  if (!res.ok) {
    throw new ApiError(
      payload?.message || `Request failed (${res.status})`,
      res.status,
      payload
    );
  }

  return payload;
}

// ------- JUDGE SANDBOX v1 -------
/** Raw judge sandbox calls. Callers get the untrusted envelope: the judge
 *  controller checks every body against contracts/judgeSandbox.v1.json. The
 *  server resolves the pair from the session; no pair, landlord or vendor id is
 *  ever sent. Every mutation carries an Idempotency-Key and is never resent
 *  automatically. */
export const JudgeSandboxAPI = {
  status: () => request<unknown>('/judge-sandbox/status'),
  start: (idempotencyKey: string) =>
    request<unknown>('/judge-sandbox/runs', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  act: (
    runId: string,
    action: 'continue' | 'pause' | 'resume',
    body: { expectedRevision: number; stepCode: string },
    idempotencyKey: string
  ) =>
    request<unknown>(`/judge-sandbox/runs/${encodeURIComponent(runId)}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
};

// ------- IRIS v2 -------
/** Raw Iris v2 calls under /landlords/iris. Callers get the untrusted envelope:
 *  components/iris/irisApi.ts checks every body against the frozen contract. */
export const IrisAPI = {
  /** keepalive: sent while the page unloads, so the browser may finish it after
   *  the page is gone. Such a call never refreshes the session. */
  call: (method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal, keepalive = false) =>
    request<unknown>(`/landlords/iris${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      ...(keepalive ? { keepalive: true, refresh: false } : {}),
    }),
};

// ------- AUTH -------
/** "Send feedback" from inside the app. Who sent it comes from the session. */
export const FeedbackAPI = {
  send: (body: { message: string; page?: string }) =>
    request('/feedback', { method: 'POST', body: JSON.stringify(body) }),
};

export const AuthAPI = {
  landlordSignup: (body: Record<string, unknown>) =>
    request('/auth/landlord/sign-up', { method: 'POST', body: JSON.stringify(body), auth: false }),
  landlordLogin: (body: { email: string; password: string }) =>
    request('/auth/landlord/login', { method: 'POST', body: JSON.stringify(body), auth: false }),
  tenantLogin: (body: { email: string; password: string }) =>
    request('/auth/tenant/login', { method: 'POST', body: JSON.stringify(body), auth: false }),
  tenantSignup: (body: Record<string, unknown>) =>
    request('/auth/tenant/sign-up', { method: 'POST', body: JSON.stringify(body), auth: false }),
  verifyInviteCode: (code: string) =>
    request('/codes/verify', { method: 'POST', body: JSON.stringify({ code }), auth: false }),

  // Beta landlord invites. `auth: false` on both: the invite token IS the
  // authorization, and the visitor has no session yet — with auth on, the
  // shared helper would try to refresh a token that does not exist and turn a
  // clean 404 into a spurious sign-out.
  //
  // The token goes in the BODY, never the URL. The server logs URLs (morgan),
  // and the emailed link carries it after a `#` so it reaches no server at all
  // until this call.
  invitePeek: (token: string) =>
    request<{
      email: string;
      firstName: string | null;
      lastName: string | null;
      accountExists: boolean;
      alreadyLandlord: boolean;
      betaDays: number;
      termsVersion: string;
    }>('/auth/landlord/invite/peek', { method: 'POST', body: JSON.stringify({ token }), auth: false }),
  inviteAccept: (body: {
    token: string;
    password: string;
    firstName: string;
    lastName: string;
    companyName?: string;
    phone?: string;
    termsAccepted: boolean;
  }) => request('/auth/landlord/invite/accept', { method: 'POST', body: JSON.stringify(body), auth: false }),

  // Password reset. `auth: false` on both — there is no session to carry, and
  // on /reset there must not be: the account's sessions are all being killed.
  //
  // forgotPassword always resolves 202 on the server; a 4xx here is a rate
  // limiter, never a verdict on the address, and the page treats it as success
  // for exactly that reason.
  forgotPassword: (email: string) =>
    request('/auth/password/forgot', { method: 'POST', body: JSON.stringify({ email }), auth: false }),
  resetPassword: (body: { token: string; password: string }) =>
    request<{ email: string; roles: string[] }>('/auth/password/reset', {
      method: 'POST',
      body: JSON.stringify(body),
      auth: false,
    }),
  me: () => request('/profile'),
  logout: () => request('/auth/logout', { method: 'POST' }),
};

// ------- AI -------
export const AIAPI = {
  meta: () => request('/ai/meta', { auth: false }),
  triage: (body: {
    message: string;
    category?: string;
    photos?: string[];
    requestId?: string;
    context?: Record<string, unknown>;
    intakeMode?: IntakeMode;
  }) => request('/ai/triage', { method: 'POST', body: JSON.stringify(body) }),
};

// ------- EVIDENCE UPLOADS -------
export type EvidenceAsset = {
  url: string;
  publicId?: string;
  type: 'image' | 'video';
  label?: string | null;
  format?: string;
  bytes?: number;
  width?: number;
  height?: number;
};

export const EvidenceAPI = {
  // Multipart upload — bypasses the JSON `request` helper so the browser can set
  // the multipart boundary itself.
  upload: async (file: File, label?: string): Promise<EvidenceAsset> => {
    const form = new FormData();
    form.append('file', file);
    if (label) form.append('label', label);
    const token = getToken();
    const res = await fetch(`${BASE}/uploads/evidence`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include',
      body: form,
    });
    const payload = (await res.json().catch(() => ({}))) as ApiEnvelope<EvidenceAsset>;
    if (!res.ok || !payload?.data) {
      throw new ApiError(payload?.message || `Upload failed (${res.status})`, res.status, payload);
    }
    return payload.data;
  },
};

// ------- REQUEST LIMITS + APPEALS -------
/** One rolling window of the tenant's request limits. */
export type QuotaWindow = { used: number; limit: number; remaining: number; resetsAt: string | null };
/** The tenant's standing against the daily / weekly request limits
 *  (backend/services/request/requestQuota.service.js). */
export type RequestQuota = {
  daily: QuotaWindow;
  weekly: QuotaWindow;
  blocked: boolean;
  blockedBy: 'daily' | 'weekly' | null;
  nextAvailableAt: string | null;
  /** Only on GET /quota: the unit's open-request cap. */
  openCount?: number;
  openCap?: number;
  /** Only on GET /quota: whether a normal (routine) request may start now.
   *  Absent from an older server, which the UI treats as not allowed. */
  creationEligibility?: CreationEligibility;
};
/** What a rejected request's card may offer, decided by the server
 *  (backend/services/request/appeal.service.js buildAppealState). */
export type AppealState = {
  state: 'none' | 'available' | 'pending' | 'expired';
  canAppeal: boolean;
  canReopen: boolean;
  /** Rejecting now would be final: the request already had its one appeal. */
  rejectIsFinal: boolean;
  rejectedAt: string | null;
  windowExpiresAt: string | null;
  note: string | null;
  appealedAt: string | null;
};

// ------- TENANT -------
export const TenantAPI = {
  listRequests: (opts: { archived?: boolean } = {}) =>
    request(`/tenants/requests${opts.archived ? '?archived=1' : ''}`),
  precheckRequest: (body: {
    description: string;
    category?: string;
    override?: 'duplicate' | 'emergency' | null;
    intakeMode?: IntakeMode;
  }) => request('/tenants/requests/precheck', { method: 'POST', body: JSON.stringify(body) }),
  createRequest: (body: Record<string, unknown>) =>
    request('/tenants/requests', { method: 'POST', body: JSON.stringify(body) }),
  /** Daily / weekly request limits and the unit's open-request cap. */
  getQuota: async () => (await request<RequestQuota>('/tenants/requests/quota')).data as RequestQuota,
  getRequest: (id: string) => request(`/requests/${id}`),
  /** Answers to the "Add missing details" questions. Spends no request quota;
   *  a 409 stale_revision carries the latest request in `data`. */
  submitIntakeDetails: (id: string, body: IntakeDetailsSubmission) =>
    request(`/tenants/requests/${id}/intake-details`, { method: 'PUT', body: JSON.stringify(body) }),
  /** A confirmed carried-over draft saved onto an existing request. No quota. */
  postRequestUpdate: (
    id: string,
    body: { body: string; submissionId: string; revision?: number; intakeMode?: IntakeMode }
  ) => request(`/tenants/requests/${id}/updates`, { method: 'POST', body: JSON.stringify(body) }),
  cancelRequest: (id: string) => request(`/tenants/requests/${id}/cancel`, { method: 'PUT' }),
  deletePendingRequest: (id: string) =>
    request(`/tenants/requests/${id}`, { method: 'DELETE' }),
  appealRequest: (id: string, note: string) =>
    request(`/tenants/requests/${id}/appeal`, {
      method: 'PUT',
      body: JSON.stringify({ note }),
    }),
  comment: (id: string, body: string) =>
    request(`/requests/${id}/comments`, { method: 'POST', body: JSON.stringify({ body }) }),
  /** Sidebar badge count: everything waiting on the tenant. Counts only. */
  badgeCounts: () => request('/tenants/badge-counts'),
  listAppointments: () => request('/tenants/appointments'),
  /** Confirms (or declines) the arrival time the vendor committed to. This is
   *  what drives awaiting_tenant -> scheduled. */
  confirmAppointment: (id: string, accepted: boolean, note?: string, revision?: number) =>
    request(`/tenants/appointments/${id}/confirm`, {
      method: 'PUT',
      body: JSON.stringify({ accepted, note: note || '', revision }),
    }),
  /** "Was this actually fixed?" — the verdict on a vendor's submitted proof.
   *  Confirming releases payment; disputing holds it and pulls the manager in. */
  verifyAppointment: (
    id: string,
    resolved: boolean,
    { rating, comment }: { rating?: number | null; comment?: string } = {}
  ) =>
    request(`/tenants/appointments/${id}/verify`, {
      method: 'PUT',
      body: JSON.stringify({ resolved, rating: rating ?? null, comment: comment || '' }),
    }),
  /** "The vendor never came." Tells the manager; re-routes nothing by itself. */
  reportNoShow: (id: string, note?: string) =>
    request(`/tenants/appointments/${id}/report-no-show`, {
      method: 'POST',
      body: JSON.stringify({ note: note || '' }),
    }),
  /** Whether this tenant is linked to a unit, and any move-out their landlord asked for. */
  getMoveOut: () => request<TenantMoveOutStatus>('/tenants/move-out'),
  confirmMoveOut: () => request('/tenants/move-out/confirm', { method: 'POST' }),
};

// ------- LANDLORD -------
/** What a landlord's banner and founding-agreement dialog render. */
export type BetaPhase = 'none' | 'quiet' | 'prominent' | 'accepted' | 'declined' | 'ended';

/** What the landlord has done about the founding offer. */
export type FoundingOffer = 'pending' | 'accepted' | 'declined' | 'none';

export interface BetaAgreement {
  version: string;
  sections: { heading: string; body: string }[];
  terms: { serviceFee: { flatCents: number; percent: number }; planDiscountPercent: number };
  chargeNoticeDays: number;
}

export interface BetaHighlights {
  requests: number;
  completed: number;
  bookedRequests: number;
  medianMinutesToBook: number | null;
  autopilotRequests: number;
  autopilotPercent: number | null;
}

export interface BetaView {
  inBeta: boolean;
  active: boolean;
  phase: BetaPhase;
  startedAt: string | null;
  endsAt: string | null;
  daysLeft: number | null;
  agreement: BetaAgreement | null;
  offer: FoundingOffer;
  /** Has accepted -- at any version. Founding is permanent once accepted. */
  founding: boolean;
  foundingSince: string | null;
  declinedAt: string | null;
  agreementAccepted: boolean;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  /** Only present when asked for (`getBeta(true)`); null if the lookup failed. */
  highlights?: BetaHighlights | null;
}

type BetaEnvelope = ApiEnvelope & { beta: BetaView };

export const LandlordAPI = {
  getWorkRecord: (id: string) => request(`/landlords/requests/${id}/work-record`),
  billing: () => request('/landlords/billing'),
  acceptBilling: (version: string) => request('/landlords/billing/accept', { method: 'POST', body: JSON.stringify({ version }) }),
  setupBillingCard: (attempt: string) => request('/landlords/billing/setup', { method: 'POST', body: JSON.stringify({ attempt }) }),
  refreshBilling: () => request('/landlords/billing/refresh', { method: 'POST' }),
  stats: () => request('/landlords/stats'),
  /** The caller's own free beta. `highlights` adds the proof numbers — a few
   *  bulk queries, so only the agreement dialog asks for them. */
  getBeta: async (highlights = false): Promise<BetaView> => {
    // These routes answer `{ beta }` at the top level rather than under `data`.
    const payload = (await request(`/landlords/beta${highlights ? '?highlights=1' : ''}`)) as BetaEnvelope;
    return payload.beta;
  },
  /** Accept the founding agreement. Send the version the dialog SHOWED: the
   *  server refuses (409 `agreement_changed`) if the offer has since changed. */
  /** Say no to the founding offer. Reversible: accepting later replaces it. */
  declineFoundingOffer: async (): Promise<BetaView> => {
    const payload = (await request('/landlords/beta/decline', { method: 'POST' })) as BetaEnvelope;
    return payload.beta;
  },
  acceptFoundingAgreement: async (version: string): Promise<BetaView> => {
    const payload = (await request('/landlords/beta/agreement', {
      method: 'POST',
      body: JSON.stringify({ version }),
    })) as BetaEnvelope;
    return payload.beta;
  },
  /** Spend, volume, speed and vendor performance over [from, to] (YYYY-MM-DD, inclusive). */
  reports: (range: { from: string; to: string }) =>
    request(`/landlords/reports?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
  /** Sidebar badge counts. Counts only — cheap enough to call on every
   *  navigation, unlike stats(), which loads the whole portfolio.
   *
   *  The `*SeenAt` marks are when this browser last opened those tabs. The
   *  server cannot know that, and without them there is nothing to measure "new
   *  since" against, so it reports zero unread rather than guessing. */
  badgeCounts: (
    seen: { walletSeenAt?: string; requestsSeenAt?: string; scheduleSeenAt?: string } = {}
  ) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(seen)) {
      if (value) params.set(key, value);
    }
    const qs = params.toString();
    return request(`/landlords/badge-counts${qs ? `?${qs}` : ''}`);
  },

  /* ---- Wallet. Amounts cross the wire as DOLLARS; the server converts to
   * integer cents at exactly one boundary (services/ledger/money.js). ------- */
  /** One page of the statement plus the balance summary. `kind`: all | added | held | paid | refunded. */
  getLedger: (params: { page?: number; limit?: number; kind?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.kind && params.kind !== 'all') query.set('kind', params.kind);
    const qs = query.toString();
    return request(`/landlords/ledger${qs ? `?${qs}` : ''}`);
  },
  /**
   * Starts a top-up: by card, or (`method: 'bank'`) a pre-authorized debit.
   * The ledger is credited by Stripe's webhook, not here. `clientToken` names
   * ONE attempt, so a double-click or a retry never starts a second payment;
   * `useSaved` debits the saved bank account straight away, with no form.
   */
  createDepositIntent: (body: { amount: number; method?: 'card' | 'bank'; clientToken?: string; useSaved?: boolean; transactionType?: 'personal' | 'business' }) =>
    request('/landlords/ledger/deposits/intent', { method: 'POST', body: JSON.stringify(body) }),
  /** Direct pay: the landlord paid the vendor themselves for this finished job.
   *  `reference` is optional (an e-transfer number). Repeating it is harmless. */
  markDirectPaymentPaid: (appointmentId: string, reference?: string) =>
    request(`/landlords/appointments/${appointmentId}/direct-payment`, {
      method: 'PUT',
      body: JSON.stringify({ reference: reference || '' }),
    }),
  markPayoutPaid: (id: string, reference?: string) =>
    request(`/landlords/ledger/entries/${id}/mark-paid`, {
      method: 'PUT',
      body: JSON.stringify({ reference: reference || '' }),
    }),
  retryPayout: (id: string) =>
    request(`/landlords/ledger/entries/${id}/retry`, { method: 'POST' }),
  /** Default: live properties. `archived: true` lists only retired ones (kept
   *  for their history); `'all'` lists both, with retired units included. */
  listProperties: (opts: { archived?: boolean | 'all' } = {}) =>
    request(
      `/landlords/properties${opts.archived === 'all' ? '?archived=all' : opts.archived ? '?archived=1' : ''}`
    ),
  createProperty: (body: Record<string, unknown>) =>
    request('/landlords/properties', { method: 'POST', body: JSON.stringify(body) }),
  /** Name, address and description only. 409 on a duplicate name, or when archived. */
  updateProperty: (id: string, body: { name?: string; address?: string; description?: string }) =>
    request<Property>(`/landlords/properties/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  /** How many booked jobs would see a changed address (the edit dialog's warning). */
  propertyEditImpact: (id: string) =>
    request<{ bookedJobs: number }>(`/landlords/properties/${id}/edit-impact`),
  /** What blocks deleting it (tenants, open jobs) and what confirming will do. */
  propertyDeletionCheck: (id: string) =>
    request<DeletionCheck>(`/landlords/properties/${id}/deletion-check`),
  /** Refused with 409 `deletion_blocked` while tenants or open jobs remain.
   *  Archives instead of deleting when the property has request history. */
  deleteProperty: (id: string) =>
    request<{ _id: string; action: 'archived' | 'deleted' }>(`/landlords/properties/${id}`, {
      method: 'DELETE',
    }),
  // Portfolio import: properties and their units in one payload. Same
  // validate-then-commit pair as bulk units, one level up.
  validatePortfolio: (properties: PortfolioImportPayload[]) =>
    request<PortfolioBatchResult>('/landlords/properties/import/validate', {
      method: 'POST',
      body: JSON.stringify({ properties }),
    }),
  importPortfolio: (properties: PortfolioImportPayload[]) =>
    request<PortfolioImported>('/landlords/properties/import', {
      method: 'POST',
      body: JSON.stringify({ properties }),
    }),
  listUnits: (propertyId?: string) =>
    request(`/landlords/units${propertyId ? `?propertyId=${propertyId}` : ''}`),
  createUnit: (body: Record<string, unknown>) =>
    request('/landlords/units', { method: 'POST', body: JSON.stringify(body) }),
  /** Renames a unit. 409 when another unit in the property already uses the number. */
  updateUnit: (id: string, body: { unitNumber: string }) =>
    request(`/landlords/units/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  unitDeletionCheck: (id: string) => request<DeletionCheck>(`/landlords/units/${id}/deletion-check`),
  deleteUnit: (id: string) =>
    request<{ _id: string; action: 'archived' | 'deleted' }>(`/landlords/units/${id}`, {
      method: 'DELETE',
    }),
  /** Asks every tenant blocking a delete to move out (resend-safe). */
  sendMoveOutNotice: (kind: 'property' | 'unit', id: string) =>
    request<{ notified: number; check: DeletionCheck | null }>('/landlords/tenants/move-out-notice', {
      method: 'POST',
      body: JSON.stringify({ kind, id }),
    }),
  /** Moves a tenant out directly — for someone who left without confirming. */
  moveOutTenant: (tenantId: string) =>
    request(`/landlords/tenants/${tenantId}/move-out`, { method: 'POST' }),
  // Bulk paths. `validateUnits` is the dry run the review table calls to check
  // proposed identifiers against what is actually in the property; `createUnits`
  // is the commit. Both take the whole batch — never a loop over createUnit.
  validateUnits: (propertyId: string, units: { name: string }[]) =>
    request<UnitBatchResult>(`/landlords/properties/${propertyId}/units/bulk/validate`, {
      method: 'POST',
      body: JSON.stringify({ units }),
    }),
  createUnits: (propertyId: string, units: { name: string }[]) =>
    request<UnitBatchCreated>(`/landlords/properties/${propertyId}/units/bulk`, {
      method: 'POST',
      body: JSON.stringify({ units }),
    }),
  generateInviteCode: (body: { propertyId: string; unitId?: string; expiresDays?: number }) =>
    request('/landlords/invite-codes', { method: 'POST', body: JSON.stringify(body) }),
  listInviteCodes: () => request('/landlords/invite-codes'),
  // Property -> Unit history. `unitId: 'none'` = requests that carry no unit.
  getArchive: (params: { propertyId?: string; unitId?: string; before?: string } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, value]) => Boolean(value)) as [string, string][]
    ).toString();
    return request(`/landlords/archive${qs ? `?${qs}` : ''}`);
  },
  deleteInviteCode: (id: string) => request(`/landlords/invite-codes/${id}`, { method: 'DELETE' }),
  listTenants: () => request('/landlords/tenants'),
  listVendors: () => request('/landlords/vendors'),
  createVendor: (body: Record<string, unknown>) =>
    request('/landlords/vendors', { method: 'POST', body: JSON.stringify(body) }),
  updateVendor: (id: string, body: Record<string, unknown>) =>
    request(`/landlords/vendors/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteVendor: (id: string) =>
    request(`/landlords/vendors/${id}`, { method: 'DELETE' }),
  getPolicy: () => request('/landlords/policy'),
  updatePolicy: (body: Record<string, unknown>) =>
    request('/landlords/policy', { method: 'PUT', body: JSON.stringify(body) }),
  routingSetup: () => request('/landlords/routing-setup'),
  listApprovalRequests: (filters?: Record<string, string>) => {
    const qs = filters ? '?' + new URLSearchParams(filters).toString() : '';
    return request(`/landlords/approval-requests${qs}`);
  },
  /** Decisions derived from request state (Approve contact, paused routing).
   *  Counted in the sidebar badge alongside pending approvals. */
  listRoutingDecisions: () => request<RoutingDecisionItem[]>('/landlords/decisions/routing'),
  decideApprovalRequest: (
    id: string,
    status: 'approved' | 'rejected' | 'expired',
    approvedAmount?: number,
    /** The stored quote revision/hash an itemized decision was raised on. A
     *  cost review sends these and never an amount. */
    expected?: { expectedQuoteRevision?: number; expectedQuoteHash?: string }
  ) =>
    request(`/landlords/approval-requests/${id}/decision`, {
      method: 'PUT',
      body: JSON.stringify({
        status,
        ...(approvedAmount != null ? { approvedAmount } : {}),
        ...(expected?.expectedQuoteRevision != null && expected.expectedQuoteHash
          ? { expectedQuoteRevision: expected.expectedQuoteRevision, expectedQuoteHash: expected.expectedQuoteHash }
          : {}),
      }),
    }),
  /** Landlord-only itemized quotes and final statements for one request, with
   *  their advisory analysis and follow-up state. Never the tenant payload. */
  getQuoteReviews: (requestId: string) =>
    request<QuoteReviews>(`/landlords/requests/${encodeURIComponent(requestId)}/quote-reviews`),
  reopenScopeReview: (requestId: string, stage: ScopeReviewStage, subjectId: string, input: ScopeReviewReopenInput) => {
    const body = scopeReviewReopenBody(input);
    if (!body || !['quote', 'invoice'].includes(stage)) throw new ApiError('Invalid scope review reopen input.', 400, { code: 'invalid_reopen_input' });
    return request<ScopeReviewReopenReceipt>(`/landlords/requests/${encodeURIComponent(requestId)}/quote-reviews/${stage}/${encodeURIComponent(subjectId)}/reopen`, { method: 'POST', body: JSON.stringify(body) });
  },
  listAgentActionLogs: (filters?: Record<string, string>) => {
    const qs = filters ? '?' + new URLSearchParams(filters).toString() : '';
    return request(`/landlords/agent-action-logs${qs}`);
  },
  /** Requests grouped once each, newest meaningful activity first. Read-only. */
  listIrisActivity: (params: { limit?: number; cursor?: string | null; activeOnly?: boolean } = {}) =>
    request<IrisActivityList>(`/landlords/iris-activity${irisActivityQuery(params)}`),
  /** One request's merged lifecycle + audit events, newest first. Read-only. */
  getRequestIrisActivity: (id: string, params: { limit?: number; cursor?: string | null } = {}) =>
    request<IrisRequestActivity>(
      `/landlords/requests/${encodeURIComponent(id)}/iris-activity${irisActivityQuery(params)}`
    ),
  listAppointments: (filters?: Record<string, string>) => {
    const qs = filters ? '?' + new URLSearchParams(filters).toString() : '';
    return request(`/landlords/appointments${qs}`);
  },
  updateAppointment: (id: string, body: Record<string, unknown>) =>
    request(`/landlords/appointments/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  /** A booking that went wrong: confirm for a silent tenant, re-route to the
   *  next vendor, or dismiss a no-show report. */
  resolveAppointment: (id: string, action: 'confirm_time' | 'reroute' | 'dismiss_no_show', revision?: number) =>
    request(`/landlords/appointments/${id}/resolve`, { method: 'POST', body: JSON.stringify({ action, revision }) }),
  createAppointment: (body: Record<string, unknown>) =>
    request('/landlords/appointments', { method: 'POST', body: JSON.stringify(body) }),
  listRequests: (filters?: Record<string, string>) => {
    const qs = filters ? '?' + new URLSearchParams(filters).toString() : '';
    return request(`/landlords/requests${qs}`);
  },
  /** Mark the tenant's follow-up details reviewed. Never sends outreach. */
  reviewIntake: (id: string, body: { revision: number; reason?: string }) =>
    request(`/landlords/requests/${id}/intake-review`, { method: 'POST', body: JSON.stringify(body) }),
  /** Record a human safety assessment. Never sends outreach. */
  reviewSafety: (id: string, body: { revision: number; disposition: SafetyReviewDisposition; reason: string }) =>
    request(`/landlords/requests/${id}/safety-review`, { method: 'POST', body: JSON.stringify(body) }),
  // Always the landlord's own vendor network; there is nothing to choose.
  generateVendorRecommendations: (id: string) =>
    request(`/landlords/requests/${id}/vendor-recommendations`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getVendorRecommendations: (id: string) =>
    request(`/landlords/requests/${id}/vendor-recommendations`),
  approveVendorContact: (id: string, vendorId: string, draftMessage?: string) =>
    request(`/landlords/requests/${id}/vendor-recommendations/${encodeURIComponent(vendorId)}/approve-contact`, {
      method: 'POST',
      body: JSON.stringify(draftMessage === undefined ? {} : { draftMessage }),
    }),
  updateVendorDraft: (id: string, vendorId: string, draftMessage: string) =>
    request(`/landlords/requests/${id}/vendor-recommendations/${encodeURIComponent(vendorId)}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ draftMessage }),
    }),
  rejectVendorRecommendation: (id: string, vendorId: string) =>
    request(`/landlords/requests/${id}/vendor-recommendations/${encodeURIComponent(vendorId)}/reject`, {
      method: 'POST',
    }),
  manualAssignVendor: (
    id: string,
    body: { candidateKey: string; overrideReason?: string }
  ) =>
    request(`/landlords/requests/${id}/vendor-recommendations/manual-assignment`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  approve: (id: string, body: Record<string, unknown>) =>
    request(`/landlords/requests/${id}/approve`, { method: 'PUT', body: JSON.stringify(body) }),
  reject: (id: string, reason: string) =>
    request(`/landlords/requests/${id}/reject`, { method: 'PUT', body: JSON.stringify({ reason }) }),
  /** Withdraw a rejection, or accept the tenant's appeal: back to the queue. */
  reopenRequest: (id: string, note?: string) =>
    request(`/landlords/requests/${id}/reopen`, { method: 'PUT', body: JSON.stringify({ note: note || '' }) }),
  /** Decline the tenant's appeal. Final: the request is removed for both sides. */
  declineAppeal: (id: string, reason: string) =>
    request(`/landlords/requests/${id}/appeal/decline`, { method: 'PUT', body: JSON.stringify({ reason }) }),
  assign: (id: string, body: Record<string, unknown>) =>
    request(`/landlords/requests/${id}/assign`, { method: 'PUT', body: JSON.stringify(body) }),
  inProgress: (id: string) =>
    request(`/landlords/requests/${id}/in-progress`, { method: 'PUT' }),
  complete: (id: string, body: Record<string, unknown>) =>
    request(`/landlords/requests/${id}/complete`, { method: 'PUT', body: JSON.stringify(body) }),
  listVendorOutreach: (id: string) => request(`/landlords/requests/${id}/vendor-outreach`),
  resendVendorOutreach: (id: string, vendorId: string) =>
    request(
      `/landlords/requests/${id}/vendor-recommendations/${encodeURIComponent(vendorId)}/resend-outreach`,
      { method: 'POST' }
    ),
  dismissVendorResponse: (id: string, outreachId: string, reason?: string) =>
    request(`/landlords/requests/${id}/vendor-outreach/${outreachId}/dismiss-response`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason || '' }),
    }),
  /** Cancels a send waiting for the vendor's opening; the vendor goes back in line. */
  cancelScheduledOutreach: (id: string, outreachId: string) =>
    request(`/landlords/requests/${id}/vendor-outreach/${outreachId}/cancel-scheduled`, { method: 'POST' }),
};

// ------- NOTIFICATIONS (any signed-in user; scoped server-side to req.user.id) -------
export type AppNotification = {
  _id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  readAt?: string | null;
  createdAt: string;
  metadata?: {
    /** The request id, despite the name. */
    workOrderId?: string | null;
    appointmentId?: string | null;
    actionUrl?: string | null;
    priority?: string | null;
  } | null;
};

/** This route answers `{ notifications, unreadCount }`, not the usual `data`. */
type NotificationListEnvelope = ApiEnvelope & { notifications?: AppNotification[]; unreadCount?: number };

export const NotificationsAPI = {
  list: async (limit = 15) => {
    const payload = (await request(`/notifications?limit=${limit}`)) as NotificationListEnvelope;
    return { notifications: payload.notifications || [], unreadCount: Number(payload.unreadCount) || 0 };
  },
  markRead: (id: string) => request(`/notifications/${id}`, { method: 'PUT' }),
  markAllRead: () => request('/notifications', { method: 'PUT' }),
};

// ------- VENDOR PORTAL (public, magic-link) -------
// `auth: false` is essential here. Without it the shared request() helper would
// attach whatever landlord bearer token happens to be in memory and, on a 401,
// fire AUTH_SESSION_EXPIRED_EVENT at a vendor who has no session at all.
/**
 * The vendor hub. Cookie-authorized, so every call must send credentials and
 * none of them attach a bearer token — a hub session is deliberately not the
 * same thing as a landlord or tenant login.
 */
export const BookingAPI = {
  returnToVendor: (id: string, body: { outreachRef: string; amount: number; start: string; durationMinutes: number; note?: string }) =>
    request(`/booking/requests/${id}/return`, { method: 'POST', body: JSON.stringify(body) }),
  get: (id: string) => request<import('../types/booking').BookingPayload | null>(`/booking/requests/${id}`),
  respond: (id: string, body: { action: 'confirm' | 'alternatives'; revision: number;
    windows?: import('../types/booking').TimeWindow[]; accessConfirmed?: boolean }) =>
    request<import('../types/booking').BookingPayload>(`/booking/requests/${id}`, { method: 'POST', body: JSON.stringify(body) }),
  retryNotice: (id: string, ref: string) => request(`/booking/requests/${id}/notices/${ref}/retry`, { method: 'POST' }),
  vendorGet: (token: string) => request<import('../types/booking').VendorBookingPayload>(
    `/booking/vendor/${encodeURIComponent(token)}`, { auth: false }),
  vendorTime: (token: string, body: { revision: number; start: string; durationMinutes: number }) =>
    request(`/booking/vendor/${encodeURIComponent(token)}`, { method: 'POST', auth: false, body: JSON.stringify(body) }),
  /** A confirmed-visit change. Each body carries only the keys the server
   * accepts; the original visit stays booked until it reports `committed`. */
  changeVisit: (id: string, body: { action: 'request_reschedule'; revision: number; reason: string;
    windows: import('../types/booking').TimeWindow[]; clientActionId: string }
    | { action: 'respond_reschedule'; proposalRef: string; expectedRevision: number; slotKey: string; accepted: boolean }
    | { action: 'decline_reschedule'; proposalRef: string; expectedRevision: number }) =>
    request<import('../types/booking').BookingPayload>(`/booking/requests/${id}`, { method: 'POST', body: JSON.stringify(body) }),
  vendorChangeVisit: (token: string, body: { action: 'confirm_reschedule'; proposalRef: string; expectedRevision: number;
    start: string; durationMinutes: number } | { action: 'decline_reschedule'; proposalRef: string; expectedRevision: number }) =>
    request<import('../types/booking').VendorBookingPayload>(`/booking/vendor/${encodeURIComponent(token)}`,
      { method: 'POST', auth: false, body: JSON.stringify(body) }),
  /** Preview only: it reads the text, never schedules or consents. */
  availability: (target: { requestId: string } | { token: string }, body: { text: string; timeZone: string }) =>
    request<import('../types/booking').AvailabilityPreview>('requestId' in target
      ? `/booking/requests/${target.requestId}/availability` : `/booking/vendor/${encodeURIComponent(target.token)}/availability`,
    { method: 'POST', auth: !('token' in target), body: JSON.stringify(body) }),
};

export const VendorHubAPI = {
  schedulingLink: (ref: string) => request<{ url: string }>(`/vendor-hub/jobs/${encodeURIComponent(ref)}/scheduling-link`, { method: 'POST', auth: false }),
  busyTimes: () => request<import('../types/booking').BusyTime[]>('/vendor-hub/busy-times', { auth: false }),
  addBusyTime: (body: { start: string; end: string; note: string }) =>
    request('/vendor-hub/busy-times', { method: 'POST', auth: false, body: JSON.stringify(body) }),
  removeBusyTime: (ref: string) => request(`/vendor-hub/busy-times/${encodeURIComponent(ref)}`, { method: 'DELETE', auth: false }),
  requestLink: (email: string) =>
    request('/vendor-hub/login', {
      method: 'POST',
      body: JSON.stringify({ email }),
      auth: false,
    }),
  enter: (token: string) =>
    request(`/vendor-hub/session/${encodeURIComponent(token)}`, { auth: false }),
  me: () => request('/vendor-hub/me', { auth: false }),
  signOut: () => request('/vendor-hub/sign-out', { method: 'POST', auth: false }),
  /** Bank details live on the vendor, so this works even after every job closes. */
  startPayouts: (businessWebsite?: string) =>
    request('/vendor-hub/payouts/onboard', { method: 'POST', auth: false, body: JSON.stringify({ businessWebsite }) }),
  /** Stripe-hosted link to change payout details once set up. */
  payoutUpdateLink: () =>
    request<{ url: string }>('/vendor-hub/payouts/update-link', { method: 'POST', auth: false }),
  /** Re-issue a link to one of this vendor's jobs. Rotates, so the old link dies. */
  issueJobLink: (ref: string) =>
    request(`/vendor-hub/jobs/${encodeURIComponent(ref)}/link`, {
      method: 'POST',
      auth: false,
    }),
};

export const VendorPortalAPI = {
  getBrief: (token: string) =>
    request(`/vendor-portal/${encodeURIComponent(token)}`, { auth: false }),
  respond: (
    token: string,
    body: {
      outcome: 'accepted' | 'declined';
      selectedSlotId?: string;
      quoteLow?: number;
      quoteHigh?: number;
      scheduledArrivalAt?: string;
      durationMinutes?: number;
      quoteNotes?: string;
      declineReason?: string;
      /** Quote contract v2 only (brief.quoteContractVersion === 2). */
      itemization?: ItemizationInput;
      expectedRevision?: 0;
      quoteContractVersion?: 2;
    }
  ) =>
    request(`/vendor-portal/${encodeURIComponent(token)}/respond`, {
      method: 'POST',
      body: JSON.stringify(body),
      auth: false,
    }),

  /** Answer a price confirmation. Deliberately carries NO amount — the server
   *  reads it from the outreach record, so a tampered body cannot change what
   *  the job books at. */
  respondToCounterOffer: (
    token: string,
    body: { decision: 'confirmed' | 'declined'; declineReason?: string }
  ) =>
    request(`/vendor-portal/${encodeURIComponent(token)}/counter-offer`, {
      method: 'POST',
      body: JSON.stringify(body),
      auth: false,
    }),

  /* ---- Completion. A DIFFERENT token: the job-scoped one minted at
   * acceptance, which outlives the outreach row. See models/JobToken.js. ---- */

  getCompletion: (token: string) =>
    request(`/vendor-portal/${encodeURIComponent(token)}/completion`, { auth: false }),

  /** Photos are appended server-side to a draft, so the submit body below
   *  carries no URLs at all and nothing client-supplied reaches the record. */
  uploadCompletionPhoto: (token: string, file: File, opts: { stage?: string; label?: string } = {}) => {
    const form = new FormData();
    form.append('file', file);
    if (opts.stage) form.append('stage', opts.stage);
    if (opts.label) form.append('label', opts.label);
    // No Content-Type header — the browser must set the multipart boundary.
    return request(`/vendor-portal/${encodeURIComponent(token)}/completion/photos`, {
      method: 'POST',
      body: form,
      auth: false,
    });
  },

  recordCheckpoint: (
    token: string,
    body: { kind: 'checkIn' | 'checkOut'; lat?: number; lng?: number; accuracyMeters?: number; denied?: boolean }
  ) =>
    request(`/vendor-portal/${encodeURIComponent(token)}/completion/checkpoint`, {
      method: 'POST',
      body: JSON.stringify(body),
      auth: false,
    }),

  /* ---- Payout setup. The endpoints existed from slice C but nothing called
   * them, so a vendor had no way to enter bank details anywhere in the product.
   * Scoped to the VendorIdentity, so a contractor working for three landlords
   * onboards once. ---- */
  getPayoutStatus: (token: string) =>
    request(`/vendor-portal/${encodeURIComponent(token)}/payouts`, { auth: false }),
  submitCompletion: (
    token: string,
    body: {
      workPerformed: string;
      partsUsed?: string;
      followUpNeeded?: boolean;
      followUpNotes?: string;
      actualCost: number;
      completedAt?: string;
      /** Required only when the cost trips the approved ceiling. The server
       *  answers 400 `overage_reason_required` rather than announcing the
       *  ceiling up front, so this is sent on the retry. */
      overageReason?: string;
      /** Quote contract v2: the fixed final statement. actualCost must equal
       *  its total exactly. */
      itemization?: ItemizationInput;
      expectedRevision?: 0;
      quoteContractVersion?: 2;
      invoiceReference?: string;
    }
  ) =>
    request(`/vendor-portal/${encodeURIComponent(token)}/completion`, {
      method: 'POST',
      body: JSON.stringify(body),
      auth: false,
    }),

  /* ---- Quote clarification. A separate, purpose-limited capability: it
   * never reads the original brief or reopens the single-use /respond. ---- */
  getQuoteClarification: (token: string) =>
    request<QuoteClarificationData>(`/vendor-portal/${encodeURIComponent(token)}/quote-clarification`, { auth: false }),
  submitQuoteClarification: (
    token: string,
    body: {
      expectedQuoteRevision: number;
      expectedQuoteHash: string;
      answers: { questionId: string; answer: string }[];
      itemization?: ItemizationInput;
    }
  ) =>
    request<{ revision: number; state: 'pending_review' }>(
      `/vendor-portal/${encodeURIComponent(token)}/quote-clarification`,
      { method: 'POST', body: JSON.stringify(body), auth: false }
    ),
};

export default {
  AuthAPI,
  AIAPI,
  TenantAPI,
  LandlordAPI,
  VendorPortalAPI,
};
