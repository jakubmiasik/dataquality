import { authenticated, decimal, entity, int, set, text, uuid } from '@microsoft/rayfin-core';

@entity()
@authenticated('*', { policy: (claims, item) => claims.sub.eq(item.user_id) })
export class ReconciliationRuleVersionField {
  @uuid() id!: string;
  @text({ max: 64 }) rule_id!: string;
  @text({ max: 64 }) version_id!: string;
  @int() ordinal!: number;
  @text({ max: 255 }) label!: string;
  @set('string', 'number', 'date', 'boolean') valueType!: 'string' | 'number' | 'date' | 'boolean';
  @set('field', 'expression', 'constant', 'aggregate') aKind!: 'field' | 'expression' | 'constant' | 'aggregate';
  @text({ max: 1000 }) aValue!: string;
  @text({ max: 20, optional: true }) aFunction?: string;
  @text({ max: 20, optional: true }) aValueKind?: string;
  @set('field', 'expression', 'constant', 'aggregate') bKind!: 'field' | 'expression' | 'constant' | 'aggregate';
  @text({ max: 1000 }) bValue!: string;
  @text({ max: 20, optional: true }) bFunction?: string;
  @text({ max: 20, optional: true }) bValueKind?: string;
  @set('absolute', 'percent', 'days', 'none') toleranceType!: 'absolute' | 'percent' | 'days' | 'none';
  @decimal({ optional: true }) toleranceValue?: number;
  @text({ max: 255 }) user_id!: string;
}