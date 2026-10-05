/**
 * Re-export of the reconciliation engine.
 *
 * The implementation lives in `gateway/src/reconciliationEngine.ts` so the
 * Azure Functions gateway can build and deploy as a self-contained artifact —
 * azd uploads only the `gateway` folder, so the engine cannot live here and
 * still be deployable. Both sides share this one implementation, so the
 * in-app preview and the server-side run can never diverge.
 */
export * from '../../gateway/src/reconciliationEngine';
