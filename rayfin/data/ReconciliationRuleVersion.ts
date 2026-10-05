import { authenticated, date, entity, int, text, uuid } from '@microsoft/rayfin-core';

@entity()
@authenticated('*', { policy: (claims, item) => claims.sub.eq(item.user_id) })
export class ReconciliationRuleVersion {
  @uuid() id!: string;
  @text({ max: 64 }) rule_id!: string;
  @int() version!: number;
  @text({ max: 4000 }) snapshot!: string;
  @text({ max: 1000, optional: true }) changeNote?: string;
  @date() changedAt!: Date;
  @text({ max: 255 }) changedBy!: string;
  @text({ max: 255 }) user_id!: string;
}