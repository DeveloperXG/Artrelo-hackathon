import type { RequestItem } from '../../types/landlord';
import RequestCard from './RequestCard';
import { useNewRequestIds } from '../../hooks/landlord/useNewRequests';

export default function RequestTable({
  requests,
  onApproveContact,
  onReject,
  onAssign,
  onComplete,
  onView,
  variant = 'default',
}: {
  requests: RequestItem[];
  onApproveContact: (request: RequestItem) => void;
  onReject: (request: RequestItem) => void;
  onAssign: (id: string) => void;
  onComplete: (id: string) => void;
  onView: (id: string) => void;
  variant?: 'default' | 'compact';
}) {
  const newIds = useNewRequestIds(requests);
  if (!requests.length) {
    return (
      <div className="py-12 text-center text-slate-400" data-testid="no-requests">
        No requests.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {requests.map((request) => (
        <RequestCard
          key={request._id}
          request={request}
          onApproveContact={onApproveContact}
          onReject={onReject}
          onAssign={onAssign}
          onComplete={onComplete}
          onView={onView}
          variant={variant}
          isNew={newIds.has(request._id)}
        />
      ))}
    </div>
  );
}
