import {
  claimSchedule,
  loadDueSchedules,
  recordScheduleOutcome,
  type StoredRule,
  type StoredSchedule,
} from './reconciliationRepository';

export interface ScheduleExecution {
  scheduleId: string;
  ruleName: string;
  ok: boolean;
  message?: string;
}

export interface SweepOptions {
  rules: StoredRule[];
  /**
   * Executes one rule and resolves with the outcome. The caller injects this so
   * the sweeper reuses exactly the same execution path as a manual run.
   */
  execute: (rule: StoredRule) => Promise<{ ok: true; runId?: string } | { ok: false; message: string }>;
  now?: Date;
}

/**
 * Runs every schedule whose next occurrence has passed.
 *
 * Rayfin has no service identity, so schedules are swept by whichever signed-in
 * browser happens to have the app open. `claimSchedule` advances the next
 * occurrence before the run starts, so two open tabs cannot run the same slot.
 */
export async function sweepSchedules({ rules, execute, now = new Date() }: SweepOptions): Promise<ScheduleExecution[]> {
  const due = await loadDueSchedules(now);
  if (!due.length) return [];
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const executions: ScheduleExecution[] = [];

  for (const schedule of due) {
    const rule = rulesById.get(schedule.rule_id);
    if (!rule) {
      if (await claimSchedule(schedule, now)) {
        await recordScheduleOutcome(schedule.id, { status: 'failed', error: 'The scheduled rule no longer exists.' });
        executions.push({ scheduleId: schedule.id, ruleName: schedule.ruleName, ok: false, message: 'The scheduled rule no longer exists.' });
      }
      continue;
    }
    if (!rule.enabled || rule.status === 'retired') {
      if (await claimSchedule(schedule, now)) {
        const message = `${rule.name} is not enabled for runs.`;
        await recordScheduleOutcome(schedule.id, { status: 'failed', error: message });
        executions.push({ scheduleId: schedule.id, ruleName: schedule.ruleName, ok: false, message });
      }
      continue;
    }
    if (!(await claimSchedule(schedule, now))) continue;

    try {
      const outcome = await execute(rule);
      if (outcome.ok) {
        await recordScheduleOutcome(schedule.id, { status: 'succeeded', runId: outcome.runId });
        executions.push({ scheduleId: schedule.id, ruleName: rule.name, ok: true });
      } else {
        await recordScheduleOutcome(schedule.id, { status: 'failed', error: outcome.message });
        executions.push({ scheduleId: schedule.id, ruleName: rule.name, ok: false, message: outcome.message });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The scheduled run failed.';
      await recordScheduleOutcome(schedule.id, { status: 'failed', error: message });
      executions.push({ scheduleId: schedule.id, ruleName: rule.name, ok: false, message });
    }
  }
  return executions;
}

export function summariseSweep(executions: ScheduleExecution[]): string {
  const failed = executions.filter((execution) => !execution.ok);
  const ran = executions.length - failed.length;
  if (!executions.length) return '';
  if (!failed.length) return `Scheduler ran ${ran} rule${ran === 1 ? '' : 's'}.`;
  return `Scheduler ran ${ran} rule${ran === 1 ? '' : 's'}, ${failed.length} failed: ${failed.map((execution) => `${execution.ruleName} (${execution.message})`).join('; ')}`;
}

export type { StoredSchedule };
