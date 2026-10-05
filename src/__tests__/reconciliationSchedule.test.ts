import { describe, expect, it } from 'vitest';

import { describeSchedule, nextOccurrence, validateSchedule } from '../services/reconciliationSchedule';

const at = (iso: string) => new Date(iso);

describe('validateSchedule', () => {
  it('accepts a well-formed weekly schedule', () => {
    expect(validateSchedule({ cadence: 'weekly', intervalCount: 2, hourUtc: 6, minuteUtc: 30, dayOfWeek: 1 })).toEqual([]);
  });

  it('rejects out-of-range and non-integer values', () => {
    const problems = validateSchedule({ cadence: 'daily', intervalCount: 0, hourUtc: 24, minuteUtc: 60.5 });
    expect(problems).toHaveLength(3);
  });

  it('requires a day of week only for weekly schedules', () => {
    expect(validateSchedule({ cadence: 'weekly', intervalCount: 1, hourUtc: 0, minuteUtc: 0 })).toEqual(['Choose a day of the week.']);
    expect(validateSchedule({ cadence: 'daily', intervalCount: 1, hourUtc: 0, minuteUtc: 0 })).toEqual([]);
  });
});

describe('nextOccurrence', () => {
  it('always lands strictly after the supplied instant', () => {
    const definition = { cadence: 'daily' as const, intervalCount: 1, hourUtc: 9, minuteUtc: 0 };
    const exactlyOnTheSlot = at('2024-03-05T09:00:00.000Z');
    expect(nextOccurrence(definition, exactlyOnTheSlot).toISOString()).toBe('2024-03-06T09:00:00.000Z');
  });

  it('returns today for a daily schedule that has not fired yet', () => {
    expect(nextOccurrence({ cadence: 'daily', intervalCount: 1, hourUtc: 9, minuteUtc: 0 }, at('2024-03-05T08:59:59.000Z')).toISOString())
      .toBe('2024-03-05T09:00:00.000Z');
  });

  it('honours multi-day intervals', () => {
    expect(nextOccurrence({ cadence: 'daily', intervalCount: 3, hourUtc: 0, minuteUtc: 0 }, at('2024-03-05T01:00:00.000Z')).toISOString())
      .toBe('2024-03-08T00:00:00.000Z');
  });

  it('advances hourly schedules to the next matching minute', () => {
    expect(nextOccurrence({ cadence: 'hourly', intervalCount: 1, hourUtc: 0, minuteUtc: 15 }, at('2024-03-05T10:20:00.000Z')).toISOString())
      .toBe('2024-03-05T11:15:00.000Z');
    expect(nextOccurrence({ cadence: 'hourly', intervalCount: 6, hourUtc: 0, minuteUtc: 0 }, at('2024-03-05T07:00:00.000Z')).toISOString())
      .toBe('2024-03-05T12:00:00.000Z');
  });

  it('rolls hourly schedules across a day boundary', () => {
    expect(nextOccurrence({ cadence: 'hourly', intervalCount: 1, hourUtc: 0, minuteUtc: 30 }, at('2024-03-05T23:45:00.000Z')).toISOString())
      .toBe('2024-03-06T00:30:00.000Z');
  });

  it('finds the next matching weekday', () => {
    // 2024-03-05 is a Tuesday; the next Friday is 2024-03-08.
    expect(nextOccurrence({ cadence: 'weekly', intervalCount: 1, hourUtc: 7, minuteUtc: 0, dayOfWeek: 5 }, at('2024-03-05T12:00:00.000Z')).toISOString())
      .toBe('2024-03-08T07:00:00.000Z');
  });

  it('skips to the following interval when the weekday slot has passed today', () => {
    // 2024-03-05 is a Tuesday and 08:00 is already behind us.
    expect(nextOccurrence({ cadence: 'weekly', intervalCount: 1, hourUtc: 7, minuteUtc: 0, dayOfWeek: 2 }, at('2024-03-05T08:00:00.000Z')).toISOString())
      .toBe('2024-03-12T07:00:00.000Z');
  });

  it('honours multi-week intervals', () => {
    expect(nextOccurrence({ cadence: 'weekly', intervalCount: 2, hourUtc: 7, minuteUtc: 0, dayOfWeek: 2 }, at('2024-03-05T08:00:00.000Z')).toISOString())
      .toBe('2024-03-19T07:00:00.000Z');
  });

  it('refuses an invalid definition instead of producing a bogus date', () => {
    expect(() => nextOccurrence({ cadence: 'weekly', intervalCount: 1, hourUtc: 0, minuteUtc: 0 }, at('2024-03-05T00:00:00.000Z')))
      .toThrow(/day of the week/i);
  });
});

describe('describeSchedule', () => {
  it('reads naturally for each cadence', () => {
    expect(describeSchedule({ cadence: 'hourly', intervalCount: 1, hourUtc: 0, minuteUtc: 5 })).toBe('Every hour at minute 05');
    expect(describeSchedule({ cadence: 'daily', intervalCount: 2, hourUtc: 9, minuteUtc: 0 })).toBe('Every 2 days at 09:00 UTC');
    expect(describeSchedule({ cadence: 'weekly', intervalCount: 1, hourUtc: 18, minuteUtc: 30, dayOfWeek: 3 })).toBe('Every week on Wednesday at 18:30 UTC');
  });
});
