import type { RequestDetailTab } from './requestDetailTypes';
import type { TabIndicators } from './requestTabActivity';

const tabs: Array<{ key: RequestDetailTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'routing', label: 'Vendor Routing' },
  { key: 'work', label: 'Work record' },
  { key: 'messages', label: 'Messages' },
  { key: 'activity', label: 'Activity' },
];

/**
 * What a tab's marker says. Messages count, because "3 new messages" is worth
 * knowing before opening; the other two are a dot. A routing change that
 * leaves the request waiting on the manager (paused, approval needed) is
 * amber, so it doesn't read the same as a vendor merely viewing an email.
 */
function TabMarker({
  tab,
  indicators,
  routingNeedsManager,
}: {
  tab: RequestDetailTab;
  indicators?: TabIndicators;
  routingNeedsManager: boolean;
}) {
  if (!indicators) return null;
  if (tab === 'messages' && indicators.messages > 0) {
    return (
      <span
        className="ml-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#137fec] px-1 text-[10px] font-bold leading-none text-white in-[.lichen-d3]:bg-primary in-[.lichen-d3]:text-primary-foreground"
        data-testid="detail-tab-marker-messages"
      >
        {indicators.messages > 9 ? '9+' : indicators.messages}
        <span className="sr-only"> new message{indicators.messages === 1 ? '' : 's'}</span>
      </span>
    );
  }
  const dot =
    (tab === 'routing' && indicators.routing) || (tab === 'activity' && indicators.activity);
  if (!dot) return null;
  const amber = tab === 'routing' && routingNeedsManager;
  return (
    <span
      className={`ml-1.5 inline-block h-2 w-2 rounded-full ${amber ? 'bg-amber-500 in-[.lichen-d3]:bg-lichen-icon' : 'bg-[#137fec] in-[.lichen-d3]:bg-chip-icon'}`}
      data-testid={`detail-tab-marker-${tab}`}
    >
      <span className="sr-only">{amber ? ' (needs your attention)' : ' (updated)'}</span>
    </span>
  );
}

export default function RequestDetailTabs({
  activeTab,
  onChange,
  indicators,
  routingNeedsManager = false,
}: {
  activeTab: RequestDetailTab;
  onChange: (tab: RequestDetailTab) => void;
  /** What changed on each tab since the landlord last opened it. */
  indicators?: TabIndicators;
  routingNeedsManager?: boolean;
}) {
  return (
    <div className="no-scrollbar relative min-w-0 w-full max-w-full overflow-x-auto">
      <div
        className="inline-flex min-w-max gap-1 rounded-xl bg-slate-100 p-1 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-chip"
        role="tablist"
        aria-label="Request detail sections"
      >
        {tabs.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`request-detail-tab-${tab.key}`}
              id={`request-detail-tab-button-${tab.key}`}
              data-testid={`detail-tab-${tab.key}`}
              onClick={() => onChange(tab.key)}
              className={`inline-flex items-center rounded-lg px-4 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#137fec]/40 in-[.lichen-d3]:rounded-md in-[.lichen-d3]:focus-visible:ring-0 in-[.lichen-d3]:focus-visible:outline-solid in-[.lichen-d3]:focus-visible:outline-2 in-[.lichen-d3]:focus-visible:outline-offset-2 in-[.lichen-d3]:focus-visible:outline-ring in-[.lichen-d3]:motion-reduce:transition-none ${
                active
                  ? "bg-white text-[#137fec] shadow-sm in-[.lichen-d3]:bg-primary in-[.lichen-d3]:text-primary-foreground in-[.lichen-d3]:shadow-none"
                  : "text-slate-500 hover:text-slate-900 in-[.lichen-d3]:text-meta in-[.lichen-d3]:hover:text-ink"
              }`}
            >
              {tab.label}
              {/* Never on the open tab: it is marked seen as it opens. */}
              {active ? null : (
                <TabMarker tab={tab.key} indicators={indicators} routingNeedsManager={routingNeedsManager} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
