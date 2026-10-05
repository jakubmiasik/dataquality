import { authenticated, date, entity, int, set, text, uuid } from '@microsoft/rayfin-core';

@entity()
@authenticated('*')
export class ReconciliationRun {
  @uuid() id!: string;
  @text({ max: 64 }) rule_id!: string;
  @int() ruleVersion!: number;
  @text({ max: 255 }) ruleName!: string;
  @set('running', 'completed', 'failed') status!: 'running' | 'completed' | 'failed';
  @int() recordsA!: number;
  @int() recordsB!: number;
  @int() keysCompared!: number;
  @int() matched!: number;
  @int() exceptionCount!: number;
  @text({ max: 4000 }) summaryJson!: string;
  @text({ max: 2000, optional: true }) errorMessage?: string;
  @date() startedAt!: Date;
  @date({ optional: true }) completedAt?: Date;
  @text({ max: 255 }) runBy!: string;
  @text({ max: 255 }) user_id!: string;
}