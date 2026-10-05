import { authenticated, boolean, date, int, set, text, uuid, entity } from '@microsoft/rayfin-core';

@entity()
@authenticated('*', { policy: (claims, item) => claims.sub.eq(item.user_id) })
export class ReconciliationRule {
  @uuid() id!: string;
  @text({ max: 255 }) name!: string;
  @text({ max: 1000, optional: true }) description?: string;
  @text({ max: 255, optional: true }) businessArea?: string;
  @text({ max: 255, optional: true }) owner?: string;
  @set('low', 'medium', 'high') priority!: 'low' | 'medium' | 'high';
  @set('draft', 'active', 'disabled', 'retired') status!: 'draft' | 'active' | 'disabled' | 'retired';
  @int() version!: number;
  @text({ max: 64 }) sourceAId!: string;
  @text({ max: 64 }) sourceBId!: string;
  @text({ max: 512 }) datasetA!: string;
  @text({ max: 512 }) datasetB!: string;
  @text({ max: 255 }) keyFieldA!: string;
  @text({ max: 255 }) keyFieldB!: string;
  @set('start_to_start', 'start_to_end', 'end_to_end', 'point_to_point', 'left_to_right', 'right_to_left', 'aggregate_to_detail', 'period_over_period', 'ungrouped')
  ruleGroup!: 'start_to_start' | 'start_to_end' | 'end_to_end' | 'point_to_point' | 'left_to_right' | 'right_to_left' | 'aggregate_to_detail' | 'period_over_period' | 'ungrouped';
  @set('exception', 'first', 'ignore') duplicateHandling!: 'exception' | 'first' | 'ignore';
  @set('exception', 'ignore') incompleteKeyHandling!: 'exception' | 'ignore';
  @int() rowLimit!: number;
  @date() createdAt!: Date;
  @text({ max: 255 }) createdBy!: string;
  @date() updatedAt!: Date;
  @text({ max: 255 }) updatedBy!: string;
  @boolean() enabled!: boolean;
  @text({ max: 255 }) user_id!: string;
}