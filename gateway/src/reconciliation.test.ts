import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bearerTokenFromHeader,
  tokensBelongToSamePrincipal,
  validateCatalogRequest,
  describeConnectFailure,
  isTransientConnectError,
  validateRequest,
} from './reconciliation';

const workspaceId = '9cf8523b-582f-4e25-b559-a1763d66fd2e';
const itemId = '14fb3c7b-a571-41fd-9131-87e69b2e165a';
const source = { workspaceId, itemId, itemType: 'Warehouse' } as const;

function token(claims: Record<string, unknown>) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`;
}

test('catalog requests accept only a valid source reference', () => {
  assert.deepEqual(validateCatalogRequest({ source }), { request: { source } });
  assert.equal(validateCatalogRequest({ source: { ...source, itemId: 'not-a-guid' } }).request, undefined);
});

test('execution accepts a structured bounded rule, not raw query strings', async () => {
  const validated = await validateRequest({
    sources: { a: source, b: { ...source, itemId: '795abb75-9db7-46df-b079-923abe9ce016', itemType: 'Lakehouse' } },
    rule: {
      keyFieldA: 'InvoiceNumber',
      keyFieldB: 'Invoice_No',
      datasetA: 'dbo.Invoices',
      datasetB: 'dbo.InvoiceView',
      rowLimit: 10000,
      compareFields: [{ label: 'Amount', type: 'number', a: { kind: 'field', value: 'Amount' }, b: { kind: 'field', value: 'Amount' } }],
    },
  });
  assert.ok(validated.request);
  assert.equal((await validateRequest({ source, leftQuery: 'SELECT * FROM dbo.Invoices' })).request, undefined);
});

test('execution accepts rowLimit 0 as the all-rows sentinel', async () => {
  const validated = await validateRequest({
    sources: { a: source, b: { ...source, itemId: '795abb75-9db7-46df-b079-923abe9ce016', itemType: 'Lakehouse' } },
    rule: {
      keyFieldA: 'InvoiceNumber',
      keyFieldB: 'Invoice_No',
      datasetA: 'dbo.Invoices',
      datasetB: 'dbo.InvoiceView',
      rowLimit: 0,
      compareFields: [{ label: 'Amount', type: 'number', a: { kind: 'field', value: 'Amount' }, b: { kind: 'field', value: 'Amount' } }],
    },
  });
  assert.equal(validated.request?.rule.rowLimit, 0);
});

test('execution rejects write-capable SQL expressions and excessive row limits', async () => {
  const base = {
    sources: { a: source, b: { ...source, itemId: '795abb75-9db7-46df-b079-923abe9ce016', itemType: 'Lakehouse' } },
    rule: {
      keyFieldA: 'Id', keyFieldB: 'Id', datasetA: 'dbo.A', datasetB: 'dbo.B', rowLimit: 10001,
      compareFields: [{ label: 'Value', type: 'string', a: { kind: 'expression', value: 'Value; DROP TABLE dbo.A' }, b: { kind: 'field', value: 'Value' } }],
    },
  };
  assert.equal((await validateRequest(base)).request, undefined);
  assert.equal((await validateRequest({ ...base, rule: { ...base.rule, rowLimit: 10001, compareFields: [{ label: 'Value', type: 'string', a: { kind: 'field', value: 'Value' }, b: { kind: 'field', value: 'Value' } }] } })).request, undefined);
});

test('gateway requires a bearer token and binds SQL and Fabric tokens to the same principal', () => {
  assert.equal(bearerTokenFromHeader('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(bearerTokenFromHeader('Basic abc'), null);
  assert.equal(tokensBelongToSamePrincipal(token({ oid: 'user-a', tid: 'tenant' }), token({ oid: 'user-a', tid: 'tenant' })), true);
  assert.equal(tokensBelongToSamePrincipal(token({ oid: 'user-a', tid: 'tenant' }), token({ oid: 'user-b', tid: 'tenant' })), false);
  assert.equal(tokensBelongToSamePrincipal(token({ oid: 'user-a', tid: 'tenant' }), token({ oid: 'user-a', tid: 'other' })), false);
});
test('transient SQL connect failures are recognised and explained as connectivity, not permissions', () => {
  assert.equal(isTransientConnectError(new Error('Failed to connect to host:1433 in 15000ms')), true);
  assert.equal(isTransientConnectError(Object.assign(new Error('boom'), { code: 'ESOCKET' })), true);
  assert.equal(isTransientConnectError(new Error('Login failed for user')), false);

  const source = { workspaceId: 'w', itemId: 'i', itemType: 'Warehouse' as const, connectionString: 'abc.datawarehouse.fabric.microsoft.com', database: 'Source' };
  const described = describeConnectFailure(source, new Error('Failed to connect to abc:1433 in 15000ms'), 3);
  assert.match(described.message, /Could not reach the SQL endpoint for "Source"/);
  assert.match(described.message, /after 3 attempt\(s\)/);
  assert.match(described.message, /rather than a permissions one/);
  assert.match(described.message, /paused/);

  // A genuine authorization error must be passed through untouched.
  const authError = new Error('Login failed for user');
  assert.equal(describeConnectFailure(source, authError, 3), authError);
});
