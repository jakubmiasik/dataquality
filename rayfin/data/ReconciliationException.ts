import { authenticated, date, entity, int, set, text, uuid } from '@microsoft/rayfin-core';

@entity()
@authenticated('*')
export class ReconciliationException {
  @uuid() id!: string;
  @text({ max: 64 }) rule_id!: string;
  @text({ max: 64 }) lastRunId!: string;
  @text({ max: 500 }) fingerprint!: string;
  @text({ max: 400 }) businessKey!: string;
  @set('missing_from_a', 'missing_from_b', 'value_mismatch', 'duplicate', 'invalid_key')
  outcome!: 'missing_from_a' | 'missing_from_b' | 'value_mismatch' | 'duplicate' | 'invalid_key';
  @set('high', 'medium', 'low') severity!: 'high' | 'medium' | 'low';
  @set('open', 'acknowledged', 'investigating', 'resolved', 'accepted')
  status!: 'open' | 'acknowledged' | 'investigating' | 'resolved' | 'accepted';
  @text({ max: 255, optional: true }) owner?: string;
  @text({ max: 4000 }) detailJson!: string;
  @date() firstSeen!: Date;
  @date() lastSeen!: Date;
  @int() occurrenceCount!: number;
  @text({ max: 255 }) user_id!: string;
}