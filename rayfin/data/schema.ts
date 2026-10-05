import { ReconciliationException } from './ReconciliationException.js';
import { ReconciliationExceptionEvent } from './ReconciliationExceptionEvent.js';
import { ReconciliationFinding } from './ReconciliationFinding.js';
import { ReconciliationRule } from './ReconciliationRule.js';
import { ReconciliationRuleField } from './ReconciliationRuleField.js';
import { ReconciliationRuleVersion } from './ReconciliationRuleVersion.js';
import { ReconciliationRuleVersionField } from './ReconciliationRuleVersionField.js';
import { ReconciliationRun } from './ReconciliationRun.js';
import { ReconciliationSource } from './ReconciliationSource.js';

export type ReconciliationAppSchema = {
	ReconciliationSource: ReconciliationSource;
	ReconciliationRule: ReconciliationRule;
	ReconciliationRuleField: ReconciliationRuleField;
	ReconciliationRuleVersion: ReconciliationRuleVersion;
	ReconciliationRuleVersionField: ReconciliationRuleVersionField;
	ReconciliationRun: ReconciliationRun;
	ReconciliationFinding: ReconciliationFinding;
	ReconciliationException: ReconciliationException;
	ReconciliationExceptionEvent: ReconciliationExceptionEvent;
};

export type BlankAppSchema = ReconciliationAppSchema;

export const schema = [
	ReconciliationSource,
	ReconciliationRule,
	ReconciliationRuleField,
	ReconciliationRuleVersion,
	ReconciliationRuleVersionField,
	ReconciliationRun,
	ReconciliationFinding,
	ReconciliationException,
	ReconciliationExceptionEvent,
];
