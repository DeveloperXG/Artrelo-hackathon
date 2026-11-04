/**
 * A refetch that live nudges, focus and a poll can all ask for without piling
 * up: one run in flight, at most one queued behind it, and none while `isBusy`
 * says a user action owns the screen (that action refreshes when it finishes).
 * A failure is swallowed; the caller's reload keeps the last good data.
 */
export function createBackgroundRefresh(run: () => Promise<unknown>, isBusy: () => boolean = () => false) {
  let inFlight: Promise<void> | null = null;
  let queued = false;

  const trigger = (): Promise<void> => {
    if (isBusy()) return inFlight || Promise.resolve();
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    const current: Promise<void> = Promise.resolve()
      .then(run)
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        if (inFlight === current) inFlight = null;
        if (queued) {
          queued = false;
          void trigger();
        }
      });
    inFlight = current;
    return current;
  };

  return trigger;
}

/**
 * Sequence guard for a reload: only the newest call may write state, so a slow
 * background response can never overwrite what a later (user-driven) load put
 * on screen.
 */
export function createLatestGuard() {
  let latest = 0;
  return {
    begin() {
      latest += 1;
      const token = latest;
      return () => token === latest;
    },
  };
}
