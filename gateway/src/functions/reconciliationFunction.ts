import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  bearerTokenFromHeader,
  executeReconciliation,
  readSourceCatalog,
  tokensBelongToSamePrincipal,
  validateCatalogRequest,
  validateRequest,
} from '../reconciliation';

const json = (status: number, body: unknown): HttpResponseInit => ({ status, jsonBody: body, headers: { 'content-type': 'application/json' } });

async function readBody(request: HttpRequest) {
  try { return await request.json(); }
  catch { throw new Error('Invalid JSON request body.'); }
}

function statusFor(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('same signed-in user')) return 401;
  if (message.includes('denied access')) return 403;
  if (message.includes('not configured')) return 503;
  if (message.includes('could not resolve') || message.includes('did not return')) return 404;
  return 502;
}

function sqlAccessTokenFromHeader(header: string | null) {
  return header?.trim() || null;
}

export async function reconciliationCatalogFunction(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const token = bearerTokenFromHeader(request.headers.get('authorization'));
    if (!token) return json(401, { error: 'A signed-in Fabric user is required.' });
    const sqlAccessToken = sqlAccessTokenFromHeader(request.headers.get('x-sql-access-token'));
    if (!sqlAccessToken) return json(401, { error: 'A delegated SQL access token is required.' });
    if (!tokensBelongToSamePrincipal(token, sqlAccessToken)) throw new Error('Fabric and SQL tokens must belong to the same signed-in user.');
    const validation = validateCatalogRequest(await readBody(request));
    if (!validation.request) return json(400, { error: validation.error });
    const catalog = await readSourceCatalog(validation.request.source, token, sqlAccessToken);
    context.log('Loaded SQL object catalog for an authorized Fabric item.');
    return json(200, catalog);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read this SQL endpoint.';
    context.warn('Fabric SQL catalog request failed.');
    return json(statusFor(error), { error: message });
  }
}

export async function reconciliationFunction(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const token = bearerTokenFromHeader(request.headers.get('authorization'));
    if (!token) return json(401, { error: 'A signed-in Fabric user is required.' });
    const sqlAccessToken = sqlAccessTokenFromHeader(request.headers.get('x-sql-access-token'));
    if (!sqlAccessToken) return json(401, { error: 'A delegated SQL access token is required.' });
    if (!tokensBelongToSamePrincipal(token, sqlAccessToken)) throw new Error('Fabric and SQL tokens must belong to the same signed-in user.');
    const validation = await validateRequest(await readBody(request));
    if (!validation.request) return json(400, { error: validation.error });
    const execution = await executeReconciliation(validation.request, token, sqlAccessToken);
    context.log('Completed a bounded, read-only reconciliation run.');
    return json(200, execution);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Reconciliation execution failed.';
    context.warn('Reconciliation execution failed.');
    return json(statusFor(error), { error: message });
  }
}

app.http('reconciliationCatalog', { methods: ['POST'], authLevel: 'anonymous', route: 'reconciliation/catalog', handler: reconciliationCatalogFunction });
app.http('reconciliationExecute', { methods: ['POST'], authLevel: 'anonymous', route: 'reconciliation/execute', handler: reconciliationFunction });
