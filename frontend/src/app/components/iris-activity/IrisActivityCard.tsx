import { useIrisActivityList } from '../../hooks/landlord/useIrisActivity';
import { IrisActivityCardView } from './IrisActivityViews';

/** The overview shows a short preview; the full feed lives on /dashboard/activity. */
const OVERVIEW_ROWS = 3;

/** Overview card: the three active requests with the newest recorded activity. */
export default function IrisActivityCard() {
  const feed = useIrisActivityList({ limit: OVERVIEW_ROWS, activeOnly: true });
  // Slice too, so a cached or oversized page can never render more rows.
  return <IrisActivityCardView feed={feed} requests={feed.requests.slice(0, OVERVIEW_ROWS)} />;
}
