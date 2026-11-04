import { useRequestIrisActivity } from '../../hooks/landlord/useIrisActivity';
import { IrisRequestActivityView } from './IrisActivityViews';

/** The landlord request Activity tab, from the shared activity projection. */
export default function IrisRequestActivityPanel({ requestId }: { requestId: string }) {
  const feed = useRequestIrisActivity(requestId);
  return <IrisRequestActivityView feed={feed} summary={feed.summary} events={feed.events} />;
}
