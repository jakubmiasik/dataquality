import { rayfinLocalDev } from '@microsoft/rayfin-local-dev/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode, command }) => {
  // Pin the dev server to Rayfin's per-project port (VITE_PORT, mapped from
  // RAYFIN_PUBLIC_FRONTEND_PORT in .env.local) so multiple local frontends
  // don't collide and the deployed backend can allow-list one stable origin.
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const port = env.VITE_PORT ? Number(env.VITE_PORT) : undefined;

  // Fail the production build early when the Rayfin publishable key is missing
  // for a remote backend. Vite statically inlines `import.meta.env.*`, so an
  // unset key would otherwise ship as `undefined` and only crash at runtime.
  // A localhost API URL resolves to the local-dev path, which needs no key.
  if (command === 'build') {
    const apiUrl = env.VITE_RAYFIN_API_URL;
    const isRemoteBackend =
      !!apiUrl && !/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(apiUrl);
    if (isRemoteBackend && !env.VITE_RAYFIN_PUBLISHABLE_KEY) {
      throw new Error(
        'Missing required Rayfin client environment variable: VITE_RAYFIN_PUBLISHABLE_KEY.\n' +
          'Regenerate .env.local from rayfin/.env with: rayfin env --framework vite\n' +
          '(run `rayfin up` first if rayfin/.env has not been populated yet).'
      );
    }
  }

  return {
    plugins: [react(), tailwindcss(), rayfinLocalDev()],
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, 'src'),
      },
    },
    ...(command === 'serve'
      ? {
          server: {
            ...(port ? { port, strictPort: true } : {}),
            proxy: {
              '/gateway-api': {
                target: 'http://localhost:7071',
                changeOrigin: true,
                rewrite: (path: string) => path.replace(/^\/gateway-api/, '/api'),
              },
            },
          },
        }
      : {}),
    build: {
      target: 'es2022',
      rollupOptions: {
        input: {
          main: resolve(import.meta.dirname, 'index.html'),
          authRedirect: resolve(import.meta.dirname, 'auth-redirect.html'),
          popupRelay: resolve(import.meta.dirname, 'popup-relay.html'),
        },
      },
    },
    esbuild: {
      target: 'es2022',
    },
    optimizeDeps: {
      esbuildOptions: {
        target: 'es2022',
      },
    },
  };
});
