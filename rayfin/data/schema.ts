import { AppSetting } from './AppSetting.js';
import { ReconciliationException } from './ReconciliationException.js';
import { ReconciliationExceptionEvent } from './ReconciliationExceptionEvent.js';
import { ReconciliationFinding } from './ReconciliationFinding.js';
import { ReconciliationRule } from './ReconciliationRule.js';
import { ReconciliationRuleField } from './ReconciliationRuleField.js';
import { ReconciliationRuleVersion } from './ReconciliationRuleVersion.js';
import { ReconciliationRuleVersionField } from './ReconciliationRuleVersionField.js';
import { ReconciliationRun } from './ReconciliationRun.js';
import { ReconciliationSchedule } from './ReconciliationSchedule.js';
import { ReconciliationSource } from './ReconciliationSource.js';

export type ReconciliationAppSchema = {
	AppSetting: AppSetting;
	ReconciliationSource: ReconciliationSource;
	ReconciliationRule: ReconciliationRule;
	ReconciliationRuleField: ReconciliationRuleField;
	ReconciliationRuleVersion: ReconciliationRuleVersion;
	ReconciliationRuleVersionField: ReconciliationRuleVersionField;
	ReconciliationRun: ReconciliationRun;
	ReconciliationFinding: ReconciliationFinding;
	ReconciliationException: ReconciliationException;
	ReconciliationExceptionEvent: ReconciliationExceptionEvent;
	ReconciliationSchedule: ReconciliationSchedule;
};

export type BlankAppSchema = ReconciliationAppSchema;

export const schema = [
	AppSetting,
	ReconciliationSource,
	ReconciliationRule,
	ReconciliationRuleField,
	ReconciliationRuleVersion,
	ReconciliationRuleVersionField,
	ReconciliationRun,
	ReconciliationFinding,
	ReconciliationException,
	ReconciliationExceptionEvent,
	ReconciliationSchedule,
];
