# Fabric Reconciliation

Rayfin-hosted React app for comparing records across Microsoft Fabric Lakehouses
and Warehouses. It inventories artifacts in accessible workspaces, reads tables,
views, and columns through SQL endpoints, and stores rules, runs, findings, and
exception history in the Rayfin data service.

## Fabric API setup

Create an Entra SPA app registration and grant delegated Fabric
`Workspace.Read.All`, `Lakehouse.Read.All`, and `Warehouse.Read.All`, plus SQL
`https://database.windows.net//user_impersonation`. Add
`http://localhost:5175/auth-redirect.html` and the deployed Rayfin app URL
followed by `/auth-redirect.html` as SPA redirect URIs. Set
`RAYFIN_PUBLIC_FABRIC_ENTRA_CLIENT_ID` and
`RAYFIN_PUBLIC_FABRIC_ENTRA_TENANT_ID` in `rayfin/.env`; Rayfin generates the
Vite names in `.env.local`. These are public SPA identifiers, not secrets.

Fabric REST and SQL endpoint calls use separate delegated tokens for the same
signed-in user. The gateway binds both tokens to the same Entra identity; SQL
object and row-level permissions are therefore applied as that user. Only
generated read-only SQL projections are executed.

The app includes MSAL's redirect bridge and popup relay pages. They are required
for popup authentication to complete when the app runs in a Fabric iframe.

## Getting started

```bash
# Start the Rayfin backend and frontend
npm run dev

# In a second terminal, start the Azure Functions SQL gateway
npm start --prefix gateway
```

Open [http://localhost:5173](http://localhost:5173). The Vite proxy forwards
`/gateway-api` to the local Functions host at `http://localhost:7071`.

## Project structure

```text
├── rayfin/
│   └── rayfin.yml          # Fabric service configuration (auth + static hosting)
├── src/
│   ├── main.tsx            # Entry point + Rayfin client bootstrap
│   ├── App.tsx             # Routes and auth gate
│   ├── hooks/
│   │   └── AuthContext.tsx # React context wrapping the auth helpers
│   ├── components/
│   │   └── AuthPage.tsx    # Sign-in UI
│   ├── pages/
│   │   ├── HomePage.tsx    # Authenticated app route
│   │   └── ReconciliationPage.tsx # Inventory, rules, runs, findings
│   └── services/
│       ├── IAuthService.ts        # Auth service contract + AuthUser type
│       ├── MockAuthService.ts     # Local-dev impl (email/password)
│       ├── RayfinAuthService.ts   # Production impl (Fabric brokered auth)
│       ├── rayfinClient.ts        # Typed Rayfin client singleton
│       └── bootstrap.ts           # Reads env, picks the right auth service
└── package.json
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Provision or reuse the Fabric backend and start local frontend/Functions code |
| `npm run build` | Production build |
| `npm run build:fabric` | Build for Fabric deployment (entrypoint for `rayfin up staticapp deploy`) |
| `npm run lint` | Lint with ESLint |
| `npm run test` | Run unit tests with Vitest |
| `npm run rayfin:up` | Deploy app to Fabric (no local dev server) |
| `npm test --prefix gateway` | Compile and test gateway validation |

## Gateway configuration

For local execution, install Azure Functions Core Tools and run the Functions
host from `gateway/` as shown above. The gateway resolves source endpoints from
Fabric REST APIs and uses the signed-in user's delegated SQL token; it does not
need a SQL password or app secret. For a deployed gateway, set
`RAYFIN_PUBLIC_RECONCILIATION_GATEWAY_URL` in `rayfin/.env` to its HTTPS origin
and allow the Rayfin app origin in the Function App CORS settings.
