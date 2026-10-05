import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const { getRayfinClient } = vi.hoisted(() => ({ getRayfinClient: vi.fn() }));
vi.mock('@/services/rayfinClient', () => ({ getRayfinClient }));

import { RuleEditor } from '@/pages/ReconciliationPage';
import type { RuleDraft } from '@/services/reconciliationRepository';
import type { CompareField } from '@/services/reconciliationEngine';

function blankDraft(): RuleDraft {
  return {
    name: 'Ledger check',
    priority: 'medium',
    sourceAId: '',
    sourceBId: '',
    datasetA: '',
    datasetB: '',
    keyFieldA: '',
    keyFieldB: '',
    ruleGroup: 'ungrouped',
    duplicateHandling: 'exception',
    incompleteKeyHandling: 'exception',
    rowLimit: 1000,
    compareFields: [{
      label: '',
      type: 'string',
      a: { kind: 'field', value: '' },
      b: { kind: 'field', value: '' },
    }],
  } as unknown as RuleDraft;
}

/** Mirrors the page's own state wiring so typing round-trips through React. */
function Harness() {
  const [draft, setDraft] = useState<RuleDraft>(blankDraft());
  return <RuleEditor
    draft={draft}
    sources={[]}
    objectsForSource={() => []}
    busy={false}
    onDraft={(key, value) => setDraft((current) => ({ ...current, [key]: value }))}
    onSelectSource={() => {}}
    onUpdateField={(index, update) => setDraft((current) => ({
      ...current,
      compareFields: current.compareFields.map((field: CompareField, position: number) => position === index ? update(field) : field),
    }))}
    onAddField={() => {}}
    onRemoveField={() => {}}
    onSave={() => {}}
    onCancel={() => {}}
    onRegisterSource={() => {}}
  />;
}

describe('RuleEditor comparison values', () => {
  it('keeps focus while a comparison label is typed', async () => {
    render(<Harness />);
    const label = screen.getByText('Label').parentElement!.querySelector('input')!;

    await userEvent.type(label, 'Net amount');

    expect(label).toHaveValue('Net amount');
    expect(label).toHaveFocus();
  });

  it('keeps focus while a SQL expression operand is typed', async () => {
    render(<Harness />);
    const operandType = screen.getAllByText('Operand type')[0].parentElement!.querySelector('select')!;
    await userEvent.selectOptions(operandType, 'expression');

    const expression = screen.getByPlaceholderText('TRIM(CustomerName)');
    await userEvent.type(expression, 'TRIM(Name)');

    expect(expression).toHaveValue('TRIM(Name)');
    expect(expression).toHaveFocus();
  });
});
