# Ryfin Reconciliation Gateway deployment plan

Status: In progress — live delegated SQL connectivity is not yet verified

## Objective

Add a secure, server-side execution path to the existing Fabric-hosted Rayfin
application. Users will configure Lakehouse or Warehouse sources per
reconciliation rule; the browser never receives a gateway credential.

## Architecture

1. The existing Rayfin React app stores rule definitions, runs, and findings in
   its managed data service.
2. An Azure Function provides a narrowly scoped HTTP execution gateway.
3. The browser sends separate delegated Fabric REST and SQL audience tokens to
  the Azure Function. The Function confirms both tokens identify the same Entra
  user, resolves the SQL endpoint through Fabric REST, and connects over TDS
  using that user's SQL token.
4. The browser never sends an endpoint hostname or arbitrary SQL to execute. The
  Function validates source IDs and rule operands, generates bounded read-only
  projections, and relies on the user's SQL object and row-level permissions.

## Infrastructure to generate

- Resource group in the user-approved Azure region.
- Flex Consumption Azure Function App (Node.js 22, Functions programming model
  v4).
- Storage account required by the Function App.
- Application Insights for gateway telemetry (no query values or credentials).
- Bicep and `azure.yaml` deployment definition in `gateway/`, isolated from
  the existing Rayfin frontend so scaffolding cannot overwrite it.

## Security and Fabric access

- No gateway service principal, tenant-wide app role, or database credential is
  required for source reads; the signed-in user supplies the delegated SQL token.
- A user must have both Fabric item visibility and SQL endpoint permissions for
  a source to be listed and queried.

## Application work

- Add managed Rayfin data entities for reconciliation sources, rules, rule
  versions, runs, exceptions, and exception events.
- Migrate the existing comparison/matching/tolerance engine from
  `powerbigovernance` into TypeScript.
- Add source selection, rule authoring, execution history, findings, and
  run-over-run comparison UI.
- Add a browser-to-gateway authenticated call with an explicit API base URL;
  validate the Fabric and SQL token identities before execution.

## Verification

- Unit tests for rule planning and reconciliation outcomes.
- Gateway tests for input validation and read-only SQL enforcement.
- `npm run lint`, `npm test`, and `npm run build` for the Rayfin app.
- Azure pre-deployment validation before any deployment.

## Required decision

Gateway region: **West Europe**.

The active subscription is `Data Team Subscription`
(`863d33c0-89ac-47c2-88d7-06200e36f0c2`). The regional Microsoft.Web quota
check completed; its reported limit is 33, although Azure did not return a
current usage figure. The current Azure Functions support matrix confirms
Node.js 22 is supported through 2027 and programming model v4 supports it.

No Azure resources will be deployed until the prepared gateway passes Azure
pre-deployment validation.

## Preparation record

- The official `functions-quickstart-typescript-azd` base template is isolated
  in `gateway/` and configured for this subscription and `westeurope`.
- The TypeScript gateway resolves each SQL endpoint from authorized Fabric item
  metadata, binds delegated tokens to the same user, reads object catalogs, and
  executes generated read-only queries with a 10,000-row bound. Gateway tests
  cover token binding, source validation, expression safety, and row limits.
- `npm install` reports four upstream high-severity dependency advisories in
  the generated template dependency tree. They must be evaluated before
  production deployment; no automated vulnerable-package upgrade was applied.

## 7. Validation Proof

- `npm run build` in `gateway/`: passed.
- `npm audit --omit=dev --json` in `gateway/`: passed; zero production
  vulnerabilities. The four advisories are development-only dependencies.
- `az bicep build --file infra/main.bicep`: completed with BCP318 warnings in
  the unmodified upstream template's conditional virtual-network modules.
- `azd provision --preview --no-prompt`: completed without applying resource
  changes.

authorized.
Validation is not yet complete: deployed Function networking, CORS, and live
delegated SQL connectivity still require verification. No Azure resources have
been deployed and no deployment is authorized.
