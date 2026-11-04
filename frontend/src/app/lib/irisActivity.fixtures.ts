// Synthetic Iris activity v1 payloads for tests. No real people or properties.
import type { IrisEvent, IrisRequestSummary } from '../types/irisActivity';

export function irisEvent(overrides: Partial<IrisEvent> = {}): IrisEvent {
  return {
    id: 'evt-1',
    requestId: 'req-a',
    source: 'audit',
    actor: 'iris',
    type: 'vendor_selected',
    title: 'Iris selected a plumber',
    summary: 'Chose the plumber who ranked first under your routing rules.',
    at: '2026-10-27T10:00:00.000Z',
    state: 'completed',
    details: [{ label: 'Criteria', value: 'Specialty, service area, your preferences' }],
    ...overrides,
  };
}

export function irisSummary(overrides: Partial<IrisRequestSummary> = {}): IrisRequestSummary {
  const requestId = overrides.requestId || 'req-a';
  return {
    requestId,
    title: 'Kitchen sink leaking under the cabinet',
    propertyLabel: 'Test Property North',
    unitLabel: 'Unit 1',
    status: 'pending',
    stage: 'outreach',
    state: 'waiting',
    summary: 'Outreach sent to one plumber.',
    waitingFor: 'the plumber to respond',
    actionRequired: false,
    updatedAt: '2026-10-27T10:00:00.000Z',
    latestEvent: irisEvent({ id: `${requestId}-latest`, requestId }),
    ...overrides,
  };
}
