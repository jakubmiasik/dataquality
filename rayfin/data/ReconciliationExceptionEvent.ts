import { authenticated, date, entity, set, text, uuid } from '@microsoft/rayfin-core';

@entity()
@authenticated('*', { policy: (claims, item) => claims.sub.eq(item.user_id) })
export class ReconciliationExceptionEvent {
  @uuid() id!: string;
  @text({ max: 64 }) exception_id!: string;
  @set('identified', 'status_changed', 'assigned', 'commented', 'severity_changed')
  action!: 'identified' | 'status_changed' | 'assigned' | 'commented' | 'severity_changed';
  @text({ max: 30, optional: true }) fromStatus?: string;
  @text({ max: 30, optional: true }) toStatus?: string;
  @text({ max: 1000, optional: true }) comment?: string;
  @text({ max: 1000, optional: true }) reason?: string;
  @text({ max: 255 }) actor!: string;
  @date() occurredAt!: Date;
  @text({ max: 255 }) user_id!: string;
}