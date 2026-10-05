import { lazy, Suspense } from 'react';

const ReconciliationPage = lazy(() => import('./ReconciliationPage').then((module) => ({ default: module.ReconciliationPage })));

export function HomePage() {
  return <Suspense fallback={<div className="app-canvas min-h-screen px-4 py-10 text-sm text-slate-500">Loading reconciliation workspace...</div>}><ReconciliationPage /></Suspense>;
}
