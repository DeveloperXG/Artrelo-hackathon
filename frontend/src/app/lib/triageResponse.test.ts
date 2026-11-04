import { describe, expect, it } from 'vitest';
import { adaptTriageResponse } from './triageResponse';

const triage = { summary: 'Outlet has no power.', category: 'Electrical', urgency: 'high' };
const tenantResponse = { nextAction: 'ask_follow_up' as const, message: 'That helps narrow it down. Are other rooms affected?' };
const workflow = { actionType: 'ask_follow_up' as const, shouldCreateTicket: false, shouldSearchVendor: false, shouldEscalateEmergency: false, vendorCategory: 'Electrical' };

describe('triage response adapter', () => {
  it('consumes the actual API envelope and preserves the signed object', () => {
    const response = { success: true, data: triage, tenantResponse, workflow, triageReceipt: 'signed' };
    const adapted = adaptTriageResponse(response);
    expect(adapted.triage).toBe(triage);
    expect(adapted.tenantResponse).toBe(tenantResponse);
    expect(adapted.workflow).toBe(workflow);
    expect(adapted.triageReceipt).toBe('signed');
    expect(JSON.stringify(adapted.triage)).toBe(JSON.stringify(triage));
  });
  it('accepts the nested compatibility shape', () => {
    expect(adaptTriageResponse({ success: true, data: { triage, tenantResponse, workflow, triageReceipt: 'nested' } }))
      .toEqual({ triage, tenantResponse, workflow, triageReceipt: 'nested' });
  });
  it('accepts legacy bare triage and gives top-level metadata precedence', () => {
    expect(adaptTriageResponse({ success: true, data: triage }).triage).toBe(triage);
    const response = { success: true, data: { triage, tenantResponse }, tenantResponse: { ...tenantResponse, message: 'Authoritative response' } };
    expect(adaptTriageResponse(response).tenantResponse?.message).toBe('Authoritative response');
  });
  it('rejects missing or malformed data', () => {
    expect(() => adaptTriageResponse({ success: true })).toThrow('incomplete');
    expect(() => adaptTriageResponse({ success: true, data: {} })).toThrow('incomplete');
  });
});
