import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Building, DollarSign, Package, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { LandlordAPI } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button } from '../../components/ui/button';
import PageHeader from '../../components/landlord/PageHeader';
import StatCard, { StatGrid, percentChange } from '../../components/landlord/StatCard';
import CountUp from '../../components/landlord/CountUp';
import {
  LandlordError,
  LandlordLoading,
  useLandlordEntrance,
} from '../../components/landlord/landlordUi';
import DecisionsBanner from '../../components/landlord/overview/DecisionsBanner';
import RequestsTrendCard from '../../components/landlord/overview/RequestsTrendCard';
import SpendCard from '../../components/landlord/overview/SpendCard';
import RequestStatusCard from '../../components/landlord/overview/RequestStatusCard';
import CategoryBarsCard from '../../components/landlord/overview/CategoryBarsCard';
import IrisActivityCard from '../../components/iris-activity/IrisActivityCard';
import { JudgeOverviewCard } from '../../components/judge/JudgeViews';
import { usePendingDecisions } from '../../hooks/landlord/usePendingDecisions';
import { useLandlordPolicy } from '../../hooks/landlord/useLandlordPolicy';
import type { Stats } from '../../types/landlord';

function greeting(now = new Date()) {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export default function OverviewPage() {
  useLandlordEntrance();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState('');
  // The same lists the Decisions page and the sidebar badge count.
  const { pendingApprovals, routingDecisions } = usePendingDecisions();
  // Only for the "set your quota" prompt; a failed load just hides it.
  const { policy } = useLandlordPolicy();

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError('');
    try {
      const response = await LandlordAPI.stats();
      setStats((response.data as Stats) || null);
    } catch (error) {
      setStatsError(error instanceof Error ? error.message : 'Failed to load overview');
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  if (statsLoading) return <LandlordLoading label="Loading overview..." />;
  if (statsError || !stats) {
    return (
      <LandlordError
        title="Overview unavailable"
        message={statsError}
        onRetry={() => void loadStats()}
      />
    );
  }

  // From the SAME two lists the Decisions page and the sidebar badge count, so
  // all three show one number. It counts decisions, not requests: one request
  // can owe two (a routing decision and an approval).
  const decisionsTotal = routingDecisions.length + pendingApprovals.length;
  const monthly = stats.monthly || [];
  const thisMonth = monthly[monthly.length - 1];
  const lastMonth = monthly[monthly.length - 2];
  const incomingChange = thisMonth && lastMonth ? percentChange(thisMonth.requests, lastMonth.requests) : null;

  // No "unassigned" count: tenants join only through a unit-linked invite
  // code, and a move-out makes them inactive, so every current tenant has a unit.
  const moveOuts = stats.pendingMoveOutCount ?? 0;
  const tenantSub = moveOuts ? `${plural(moveOuts, 'move-out')} pending` : 'All in their units';

  return (
    <div>
      <PageHeader
        title={user?.firstName ? `${greeting()}, ${user.firstName}` : greeting()}
        description="Here's what's happening with your properties today."
      />

      {/* No default quota yet. Until there is one, Artrelo contacts no vendor on
          its own, so this is the first thing a new manager should do — and the
          one thing that turns every "approve this job" card into autopilot. */}
      <JudgeOverviewCard />
      {policy && policy.defaultQuota === null ? (
        <div
          className="ll-fade-up mb-6 flex flex-col gap-3 rounded-lg border border-lichen-line bg-lichen-wash p-5 sm:flex-row sm:items-center sm:justify-between"
          data-testid="overview-set-quota"
        >
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-lichen-tint p-2.5 text-lichen-text">
              <DollarSign className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <div className="text-sm font-semibold text-ink">Set your spending quota</div>
              <p className="mt-0.5 text-sm text-meta">
                Choose how much a job can cost before it needs your approval. Until you do, you&rsquo;ll
                approve every vendor contact yourself.
              </p>
            </div>
          </div>
          {/* Opens the Policy page; nothing is approved or billed from here. */}
          <Button className="shrink-0" onClick={() => navigate('/dashboard/policy')}>
            Set quota
          </Button>
        </div>
      ) : null}

      <StatGrid className="mb-6">
        <StatCard
          icon={Building}
          label="Properties"
          value={<CountUp value={stats.propertyCount} />}
          sub={plural(stats.unitCount, 'unit')}
          onClick={() => navigate('/dashboard/properties')}
          testId="overview-stat-properties"
        />
        <StatCard
          icon={Package}
          label="Units"
          value={<CountUp value={stats.unitCount} />}
          sub={`${stats.occupiedUnitCount ?? 0} occupied`}
          onClick={() => navigate('/dashboard/properties')}
          delay={60}
          testId="overview-stat-units"
        />
        <StatCard
          icon={Users}
          label="Tenants"
          value={<CountUp value={stats.tenantCount} />}
          sub={tenantSub}
          onClick={() => navigate('/dashboard/tenants')}
          delay={120}
          testId="overview-stat-tenants"
        />
        <StatCard
          icon={AlertTriangle}
          // Urgent is the owner's Alert role; otherwise a neutral chip.
          tone={stats.urgentCount ? 'rose' : 'slate'}
          label="Open requests"
          // NOT requestCount — that is every request ever raised, so the number
          // only ever went up and completing a job changed nothing.
          value={<CountUp value={stats.openRequestCount ?? 0} />}
          delta={
            incomingChange === null
              ? null
              : { percent: incomingChange, upIsGood: false, label: 'incoming vs last month' }
          }
          sub={stats.urgentCount ? `· ${stats.urgentCount} urgent` : undefined}
          onClick={() => navigate('/dashboard/requests')}
          delay={180}
          testId="overview-stat-open"
        />
      </StatGrid>

      <DecisionsBanner total={decisionsTotal} onReview={() => navigate('/dashboard/decisions')} />

      <div className="grid min-w-0 gap-6 lg:@min-[58rem]/page:grid-cols-3">
        <RequestsTrendCard stats={stats} />
        <SpendCard stats={stats} onViewReports={() => navigate('/dashboard/reports')} />
      </div>

      {/* items-start: each card keeps its own height instead of stretching to
          the tallest one in the row. */}
      <div className="mt-6 grid min-w-0 items-start gap-6 lg:@min-[58rem]/page:grid-cols-3">
        <RequestStatusCard byStatus={stats.byStatus} />
        <CategoryBarsCard byCategory={stats.byCategory} />
        {/* Latest recorded activity on active requests -- not newest-created,
            which is what this slot used to show. */}
        <IrisActivityCard />
      </div>
    </div>
  );
}
