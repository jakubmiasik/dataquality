import { authenticated, date, entity, set, text, uuid } from '@microsoft/rayfin-core';

@entity()
@authenticated('*')
export class ReconciliationFinding {
  @uuid() id!: string;
  @text({ max: 64 }) run_id!: string;
  @text({ max: 64 }) rule_id!: string;
  @text({ max: 64, optional: true }) exception_id?: string;
  @text({ max: 500 }) fingerprint!: string;
  @text({ max: 400 }) businessKey!: string;
  @set('missing_from_a', 'missing_from_b', 'value_mismatch', 'duplicate', 'invalid_key')
  outcome!: 'missing_from_a' | 'missing_from_b' | 'value_mismatch' | 'duplicate' | 'invalid_key';
  @set('high', 'medium', 'low') severity!: 'high' | 'medium' | 'low';
  @text({ max: 4000 }) detailJson!: string;
  @date() recordedAt!: Date;
  @text({ max: 255 }) user_id!: string;
}