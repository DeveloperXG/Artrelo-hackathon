import { useSearchParams } from 'react-router-dom';
import { HackathonBadge } from '../../components/judge/JudgeBadges';
import PageHeader from '../../components/landlord/PageHeader';
import { PageContainer, SectionCard, useLandlordEntrance } from '../../components/landlord/landlordUi';
import { IrisActivityListView } from '../../components/iris-activity/IrisActivityViews';
import { useIrisActivityList } from '../../hooks/landlord/useIrisActivity';

const FILTERS = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All requests' },
] as const;

/**
 * Every request once, newest recorded activity first: its stage, the latest
 * meaningful action, what it is waiting on and whether you need to act.
 */
export default function IrisActivityPage() {
  useLandlordEntrance();
  const [searchParams, setSearchParams] = useSearchParams();
  // Active by default: closed requests are history, not something to watch.
  const activeOnly = searchParams.get('show') !== 'all';
  const feed = useIrisActivityList({ limit: 20, activeOnly });

  const setFilter = (value: 'active' | 'all') =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === 'active') next.delete('show');
        else next.set('show', 'all');
        return next;
      },
      { replace: true }
    );

  return (
    <PageContainer>
      <PageHeader
        title="Activity"
        titleTestId="iris-activity-title"
        actions={<HackathonBadge />}
        description="What is happening on each request, what it is waiting on, and where you need to step in."
      />
      <SectionCard
        title={activeOnly ? 'Active requests' : 'All requests'}
        description="Newest activity first. Open a request for its full history."
        action={
          // Migrated to Lichen (D2): the page column is the scope (lib/lichenRoutes).
          <div role="group" aria-label="Show" className="inline-flex rounded-md border border-border bg-well p-0.5">
            {FILTERS.map((filter) => {
              const selected = (filter.value === 'active') === activeOnly;
              return (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={selected}
                  data-testid={`iris-filter-${filter.value}`}
                  onClick={() => setFilter(filter.value)}
                  className={`rounded-[4px] px-3 py-1.5 text-xs font-semibold transition-colors motion-reduce:transition-none ${
                    selected
                      ? 'bg-lichen text-on-lichen forced-colors:border forced-colors:border-[Highlight]'
                      : 'text-meta hover:text-ink'
                  }`}
                >
                  {filter.label}
                </button>
              );
            })}
          </div>
        }
      >
        <IrisActivityListView feed={feed} requests={feed.requests} activeOnly={activeOnly} />
      </SectionCard>
    </PageContainer>
  );
}
