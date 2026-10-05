import { authenticated, boolean, date, entity, int, set, text, uuid } from '@microsoft/rayfin-core';

@entity()
@authenticated('*')
export class ReconciliationSchedule {
  @uuid() id!: string;
  @text({ max: 64 }) rule_id!: string;
  @text({ max: 255 }) ruleName!: string;
  @boolean() enabled!: boolean;
  @set('hourly', 'daily', 'weekly') cadence!: 'hourly' | 'daily' | 'weekly';
  @int() intervalCount!: number;
  @int() hourUtc!: number;
  @int() minuteUtc!: number;
  @int({ optional: true }) dayOfWeek?: number;
  @date() nextDueAt!: Date;
  @date({ optional: true }) lastTriggeredAt?: Date;
  @text({ max: 64, optional: true }) lastRunId?: string;
  @set('idle', 'queued', 'running', 'succeeded', 'failed')
  lastStatus!: 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';
  @text({ max: 2000, optional: true }) lastError?: string;
  @date() createdAt!: Date;
  @text({ max: 255 }) createdBy!: string;
  @date() updatedAt!: Date;
  @text({ max: 255 }) updatedBy!: string;
  @text({ max: 255 }) user_id!: string;
}
