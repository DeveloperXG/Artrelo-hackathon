import {
  Building2,
  Bug,
  Droplet,
  FileQuestion,
  Lock,
  Wind,
  Wrench,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AppealState } from '../../api/client';
import type { IntakeFollowUp, TenantSafetyAssessment } from '../../types/requestWorkflow';

/**
 * Shared types, constants and helpers for the tenant maintenance-request
 * surface. Kept in one module so the requests list, the new-request flow and
 * the data hook all speak the same shape.
 */

export interface Request {
  _id: string;
  issueTitle: string;
  issueDescription: string;
  category: string;
  status: string;
  lifecycleStatus?: string;
  urgency: string;
  createdAt: string;
  /** Already sent by the API; the type just never declared it. */
  appointmentStatus?: string;
  eta?: string;
  rejectionReason?: string;
  appealWindowExpiresAt?: string;
  isAppealed?: boolean;
  appealNote?: string;
  /** Server-decided: whether the Appeal button shows, and why not. */
  appeal?: AppealState;
  /** Questions the tenant can still answer; null when none are owed. */
  intakeFollowUp?: IntakeFollowUp | null;
  safetyAssessment?: TenantSafetyAssessment | null;
  /** Optimistic-concurrency token for tenant writes, when the server sends one. */
  revision?: number;
  ai?: {
    summary?: string;
    shortTitle?: string;
    urgency?: string;
    category?: string;
    safetyWarning?: string;
    followUpQuestions?: string[];
  };
}

export const CATEGORY_LIST: { id: string; name: string; icon: LucideIcon }[] = [
  { id: 'Plumbing', name: 'Plumbing', icon: Droplet },
  { id: 'Electrical', name: 'Electrical', icon: Zap },
  { id: 'HVAC', name: 'HVAC', icon: Wind },
  { id: 'Appliance', name: 'Appliance', icon: Wrench },
  { id: 'Structural', name: 'Structural', icon: Building2 },
  { id: 'Pest', name: 'Pest Control', icon: Bug },
  { id: 'Locks/Hardware', name: 'Locks/Hardware', icon: Lock },
  { id: 'Other', name: 'Other', icon: FileQuestion },
];

export const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  approved: 'Approved',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  completed: 'Completed',
  rejected: 'Rejected',
  appeal_pending: 'Appeal pending',
  cancelled: 'Cancelled',
};

export const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-amber-500 text-white',
  approved: 'bg-sky-500 text-white',
  assigned: 'bg-indigo-500 text-white',
  in_progress: 'bg-blue-500 text-white',
  completed: 'bg-emerald-500 text-white',
  rejected: 'bg-rose-500 text-white',
  appeal_pending: 'bg-fuchsia-500 text-white',
  cancelled: 'bg-slate-500 text-white',
};

export const TENANT_PRIORITY_LABELS: Record<string, string> = {
  low: 'Received',
  medium: 'Under review',
  high: 'Flagged as urgent',
  // Not "notice sent": whether anyone was alerted depends on their settings.
  emergency: 'Flagged as an emergency',
};

// The landlord can advance a request (e.g. approve vendor contact) without the
// raw `status` leaving "queued", so prefer the backend-derived lifecycle stage.
export const getEffectiveStatus = (request: { status: string; lifecycleStatus?: string }) =>
  request.lifecycleStatus || request.status;
