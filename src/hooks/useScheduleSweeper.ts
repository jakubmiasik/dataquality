import { useEffect, useRef } from 'react';

import { sweepSchedules, type ScheduleExecution } from '../services/reconciliationScheduler';
import type { StoredRule } from '../services/reconciliationRepository';

const SWEEP_INTERVAL_MS = 60_000;

export interface ScheduleSweeperOptions {
  /** Sweeping is skipped until the user is signed in and rules have loaded. */
  enabled: boolean;
  rules: StoredRule[];
  execute: (rule: StoredRule) => Promise<{ ok: true; runId?: string } | { ok: false; message: string }>;
  onSwept: (executions: ScheduleExecution[]) => void;
}

/**
 * Polls for due schedules while the app is open.
 *
 * Rayfin has no service identity, so there is no server-side timer. Each signed-in
 * browser sweeps once a minute and `claimSchedule` keeps concurrent tabs from
 * running the same slot twice.
 */
export function useScheduleSweeper({ enabled, rules, execute, onSwept }: ScheduleSweeperOptions) {
  // Kept in refs so a re-render never restarts the interval or stacks sweeps.
  const latest = useRef({ rules, execute, onSwept });
  const running = useRef(false);
  latest.current = { rules, execute, onSwept };

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function sweep() {
      if (running.current || cancelled) return;
      running.current = true;
      try {
        const executions = await sweepSchedules({
          rules: latest.current.rules,
          execute: latest.current.execute,
        });
        if (!cancelled && executions.length) latest.current.onSwept(executions);
      } catch {
        // A transient sweep failure must not break the page; the next tick retries.
      } finally {
        running.current = false;
      }
    }

    void sweep();
    const timer = window.setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);
}
