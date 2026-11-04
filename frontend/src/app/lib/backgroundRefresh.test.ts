import { describe, expect, it, vi } from 'vitest';
import { createBackgroundRefresh, createLatestGuard } from './backgroundRefresh';

const tick = () => new Promise((done) => setTimeout(done, 0));

describe('createBackgroundRefresh', () => {
  it('coalesces a burst of nudges into one run in flight and one queued behind it', async () => {
    let release!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((done) => {
          release = done;
        })
    );
    const trigger = createBackgroundRefresh(run);
    void trigger();
    void trigger();
    void trigger();
    await tick();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await tick();
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not run while a user action is busy, and runs again once it is not', async () => {
    let busy = true;
    const run = vi.fn(async () => {});
    const trigger = createBackgroundRefresh(run, () => busy);
    await trigger();
    expect(run).not.toHaveBeenCalled();
    busy = false;
    await trigger();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed run and still serves the next nudge', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const trigger = createBackgroundRefresh(run);
    await expect(trigger()).resolves.toBeUndefined();
    await trigger();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('never loops: a run that completes does not schedule another by itself', async () => {
    const run = vi.fn(async () => {});
    const trigger = createBackgroundRefresh(run);
    await trigger();
    await tick();
    await tick();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('createLatestGuard', () => {
  it('lets only the newest call write, so a slow background response is dropped', () => {
    const guard = createLatestGuard();
    const background = guard.begin();
    const userAction = guard.begin();
    expect(background()).toBe(false);
    expect(userAction()).toBe(true);
  });
});
