import { ApiError, IrisAPI } from '../../api/client';
import { IrisContractViolation, loadIrisContract, type IrisContract } from '../../contracts/irisContract';
import type {
  AcceptedTurn,
  Cancellation,
  ConversationClosed,
  ConversationView,
  ErrorCode,
  EvidenceView,
  HttpErrorBody,
  ImpactPage,
  Origin,
  PolicyChangeView,
  TurnView,
} from '../../types/irisV2';

/**
 * Why an Iris call failed, in the terms the UI needs:
 * - http: a closed contract error the server returned (exact code/status);
 * - transport: no response at all (offline, reset). For a confirm this means
 *   the outcome is UNKNOWN, never "failed";
 * - unexpected: a response that is not a contract error body (proxy 502 page);
 * - contract: a 2xx body that does not match the frozen schema;
 * - aborted: we cancelled it ourselves (navigation, auth loss).
 */
export type IrisFailure =
  | {
      kind: 'http';
      status: number;
      code: ErrorCode;
      retryAfterSeconds: number | null;
      currentPolicyRevision: number | null;
      field: string | null;
    }
  | { kind: 'transport' }
  | { kind: 'unexpected'; status: number }
  | { kind: 'contract' }
  | { kind: 'aborted' };

export class IrisCallError extends Error {
  readonly failure: IrisFailure;
  constructor(failure: IrisFailure) {
    super(failure.kind === 'http' ? `Iris ${failure.code}` : `Iris ${failure.kind}`);
    this.failure = failure;
  }
}

/** The calls the controller makes; tests inject a fake with the same shape. */
export interface IrisApi {
  createConversation(clientConversationId: string): Promise<ConversationView>;
  resolveContext(
    conversationId: string,
    body: { requestContextId: string | null; contextGeneration: number },
    signal?: AbortSignal
  ): Promise<Origin>;
  closeConversation(conversationId: string, clientActionId: string): Promise<ConversationClosed>;
  /** The same close, sent as an unload keepalive (pagehide). */
  closeOnPagehide(conversationId: string, clientActionId: string): Promise<ConversationClosed>;
  postTurn(
    conversationId: string,
    body: { clientTurnId: string; text: string; requestContextId: string | null; contextGeneration: number },
    signal?: AbortSignal
  ): Promise<AcceptedTurn>;
  getTurn(turnId: string, signal?: AbortSignal): Promise<TurnView>;
  cancelTurn(turnId: string, clientActionId: string): Promise<Cancellation>;
  getPolicyChange(id: string, signal?: AbortSignal): Promise<PolicyChangeView>;
  getImpact(id: string, cursor: string | null, signal?: AbortSignal): Promise<ImpactPage>;
  confirm(
    id: string,
    body: {
      confirmationToken: string;
      clientActionId: string;
      expectedPolicyRevision: number | null;
      patchHash: string;
      impactHash: string;
    }
  ): Promise<PolicyChangeView>;
  discard(id: string, clientActionId: string): Promise<PolicyChangeView>;
  getEvidence(ref: string, signal?: AbortSignal): Promise<EvidenceView>;
}

export const IMPACT_PAGE_LIMIT = 50;

function toFailure(error: unknown, contract: IrisContract): IrisFailure {
  if (error instanceof IrisCallError) return error.failure;
  if (error instanceof IrisContractViolation) return { kind: 'contract' };
  if (error instanceof DOMException && error.name === 'AbortError') return { kind: 'aborted' };
  if (error instanceof ApiError) {
    const body = error.payload;
    if (contract.errorsFor('HttpError', body).length === 0) {
      const http = body as HttpErrorBody;
      return {
        kind: 'http',
        status: error.status,
        code: http.code,
        retryAfterSeconds: http.retryAfterSeconds,
        currentPolicyRevision: http.currentPolicyRevision,
        field: http.field,
      };
    }
    return { kind: 'unexpected', status: error.status };
  }
  // fetch rejects with a TypeError when no response arrives.
  return { kind: 'transport' };
}

const seg = (value: string) => encodeURIComponent(value);

async function call<T>(
  method: 'GET' | 'POST',
  template: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  keepalive = false
): Promise<T> {
  const contract = await loadIrisContract();
  const endpoint = contract.endpoint(method, template);
  try {
    if (method === 'POST') contract.checkInput(endpoint, body);
    const payload = await IrisAPI.call(method, path, method === 'POST' ? body : undefined, signal, keepalive);
    return contract.checkEnvelope<T>(endpoint, payload);
  } catch (error) {
    throw new IrisCallError(toFailure(error, contract));
  }
}

export const irisApi: IrisApi = {
  createConversation: (clientConversationId) =>
    call('POST', '/conversations', '/conversations', { clientConversationId }),
  resolveContext: (conversationId, body, signal) =>
    call('POST', '/conversations/:id/context', `/conversations/${seg(conversationId)}/context`, body, signal),
  closeConversation: (conversationId, clientActionId) =>
    call('POST', '/conversations/:id/close', `/conversations/${seg(conversationId)}/close`, { clientActionId }),
  closeOnPagehide: (conversationId, clientActionId) =>
    call('POST', '/conversations/:id/close', `/conversations/${seg(conversationId)}/close`, { clientActionId }, undefined, true),
  postTurn: (conversationId, body, signal) =>
    call('POST', '/conversations/:id/turns', `/conversations/${seg(conversationId)}/turns`, body, signal),
  getTurn: (turnId, signal) => call('GET', '/turns/:id', `/turns/${seg(turnId)}`, undefined, signal),
  cancelTurn: (turnId, clientActionId) =>
    call('POST', '/turns/:id/cancel', `/turns/${seg(turnId)}/cancel`, { clientActionId }),
  getPolicyChange: (id, signal) => call('GET', '/policy-changes/:id', `/policy-changes/${seg(id)}`, undefined, signal),
  getImpact: (id, cursor, signal) => {
    // Query input {cursor, limit}: a null cursor (first page) is sent as absent.
    const qs = new URLSearchParams({ limit: String(IMPACT_PAGE_LIMIT) });
    if (cursor) qs.set('cursor', cursor);
    return call('GET', '/policy-changes/:id/impact', `/policy-changes/${seg(id)}/impact?${qs}`, undefined, signal);
  },
  confirm: (id, body) => call('POST', '/policy-changes/:id/confirm', `/policy-changes/${seg(id)}/confirm`, body),
  discard: (id, clientActionId) =>
    call('POST', '/policy-changes/:id/discard', `/policy-changes/${seg(id)}/discard`, { clientActionId }),
  getEvidence: (ref, signal) => call('GET', '/evidence/:ref', `/evidence/${seg(ref)}`, undefined, signal),
};
