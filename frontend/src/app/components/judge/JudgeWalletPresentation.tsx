import type { ReactNode } from 'react';
import { useJudgeSandbox } from './JudgeSandboxProvider';

/** Presentation gate only. The backend remains the payment authority. */
export function JudgeMoneyActions({ children }: { children: ReactNode }) {
  const { view } = useJudgeSandbox();
  return view.loaded && !view.refreshFailed && !view.status.enabled ? <>{children}</> : null;
}

export function JudgeWalletNotice() {
  const { view } = useJudgeSandbox();
  return (
    <>
      {!view.loaded ? <p role="status" className="mb-4 text-sm">Checking payment controls…</p> : null}
      {view.refreshFailed ? (
        <p role="alert" className="mb-4 text-sm">
          Payment controls are temporarily unavailable. Refresh this page to check access again.
        </p>
      ) : null}
      {view.status.enabled ? (
        <p className="lichen lichen-light mb-4 rounded-lg border border-hairline bg-background p-4 font-sans text-sm text-ink" data-testid="judge-wallet-notice">
          This Wallet contains synthetic demo records. A pending manual payout records an amount payable; no real money was sent and no bank receipt is verified. Adding funds and marking payments paid are unavailable in this sandbox.
        </p>
      ) : null}
    </>
  );
}
