export type ScheduleCadence = 'hourly' | 'daily' | 'weekly';

export interface ScheduleDefinition {
  cadence: ScheduleCadence;
  /** Number of cadence units between runs, e.g. every 2 hours or every 3 days. */
  intervalCount: number;
  hourUtc: number;
  minuteUtc: number;
  /** 0 = Sunday .. 6 = Saturday. Only meaningful for the weekly cadence. */
  dayOfWeek?: number;
}

export function validateSchedule(definition: ScheduleDefinition): string[] {
  const problems: string[] = [];
  if (!['hourly', 'daily', 'weekly'].includes(definition.cadence)) problems.push('Choose a valid cadence.');
  if (!Number.isInteger(definition.intervalCount) || definition.intervalCount < 1 || definition.intervalCount > 52) {
    problems.push('The interval must be a whole number between 1 and 52.');
  }
  if (!Number.isInteger(definition.hourUtc) || definition.hourUtc < 0 || definition.hourUtc > 23) {
    problems.push('The hour must be between 0 and 23 (UTC).');
  }
  if (!Number.isInteger(definition.minuteUtc) || definition.minuteUtc < 0 || definition.minuteUtc > 59) {
    problems.push('The minute must be between 0 and 59.');
  }
  if (definition.cadence === 'weekly') {
    if (!Number.isInteger(definition.dayOfWeek) || definition.dayOfWeek! < 0 || definition.dayOfWeek! > 6) {
      problems.push('Choose a day of the week.');
    }
  }
  return problems;
}

const hourMs = 3600000;
const dayMs = 86400000;

/**
 * Returns the first occurrence strictly after `from`, so a schedule can never
 * fire twice for the same slot.
 */
export function nextOccurrence(definition: ScheduleDefinition, from: Date): Date {
  const problems = validateSchedule(definition);
  if (problems.length) throw new Error(problems.join(' '));
  const after = from.getTime();

  if (definition.cadence === 'hourly') {
    const step = definition.intervalCount * hourMs;
    const anchor = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 0, definition.minuteUtc, 0, 0);
    const elapsed = after - anchor;
    const steps = elapsed < 0 ? 0 : Math.floor(elapsed / step) + 1;
    return new Date(anchor + steps * step);
  }

  if (definition.cadence === 'daily') {
    const step = definition.intervalCount * dayMs;
    const anchor = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), definition.hourUtc, definition.minuteUtc, 0, 0);
    if (anchor > after) return new Date(anchor);
    const steps = Math.floor((after - anchor) / step) + 1;
    return new Date(anchor + steps * step);
  }

  const step = definition.intervalCount * 7 * dayMs;
  const target = definition.dayOfWeek ?? 0;
  const base = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), definition.hourUtc, definition.minuteUtc, 0, 0);
  const dayDelta = (target - from.getUTCDay() + 7) % 7;
  let candidate = base + dayDelta * dayMs;
  while (candidate <= after) candidate += step;
  return new Date(candidate);
}

export function describeSchedule(definition: ScheduleDefinition): string {
  const time = `${String(definition.hourUtc).padStart(2, '0')}:${String(definition.minuteUtc).padStart(2, '0')} UTC`;
  const every = definition.intervalCount === 1 ? '' : `${definition.intervalCount} `;
  if (definition.cadence === 'hourly') {
    return `Every ${every}hour${definition.intervalCount === 1 ? '' : 's'} at minute ${String(definition.minuteUtc).padStart(2, '0')}`;
  }
  if (definition.cadence === 'daily') {
    return `Every ${every}day${definition.intervalCount === 1 ? '' : 's'} at ${time}`;
  }
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `Every ${every}week${definition.intervalCount === 1 ? '' : 's'} on ${days[definition.dayOfWeek ?? 0]} at ${time}`;
}
