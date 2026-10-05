import { RayfinClient } from '@microsoft/rayfin-client';
import { resolveRayfinFunctionsBaseUrl } from '@microsoft/rayfin-local-dev';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BlankAppSchema } from '../../rayfin/data/schema';

type TestFunctions = {
  hello: {
    input: { name: string };
    output: string;
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local Functions routing', () => {
  it('keeps the final request on the Vite origin with a Fabric base URL', async () => {
    vi.stubGlobal('__RAYFIN_LOCAL_FUNCTIONS_PROXY__', true);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          functionName: 'hello',
          invocationId: 'inv-local',
          status: 'Success',
          output: 'Hello, Ada!',
          errors: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new RayfinClient<BlankAppSchema, TestFunctions>({
      baseUrl: 'https://fabric.example.com/webapi/capacities/1/appbackends/2/',
      publishableKey: 'pk-test-key-12345678',
      functionsBaseUrl: resolveRayfinFunctionsBaseUrl(),
      authStorage: false,
      persistSession: false,
      autoRefreshToken: false,
      multiTabSync: false,
    });

    await client.functions.hello.invoke({ name: 'Ada' });

    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}/.rayfin/api/hello`,
      expect.objectContaining({ method: 'POST' })
    );
  });
});
