import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkDeploymentUrl, isCloudflareAccessProtectedResponse, readCloudflareWorkersConfig, writeCloudflareWorkersConfig } from '../src/deploy.js';
import {
  deployToCloudflareWorkers,
  probeCloudflareWorkersCapabilities,
} from '../src/deploy/cloudflare-workers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

type Call = [string, RequestInit | undefined];

const INDEX = { file: 'index.html', data: Buffer.from('<h1>hi</h1>') };
const base = { config: { token: 'tok-secret', accountId: 'acct_test' }, files: [INDEX], projectName: 'My Site' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function accessFetch(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    if (url.includes('assets-upload-session')) {
      return jsonResponse(overrides.session ?? { success: true, result: { jwt: 'SESS', buckets: [] } });
    }
    if (url.includes('/workers/assets/upload')) {
      return jsonResponse(overrides.upload ?? { success: true, result: { jwt: 'COMPLETION' } });
    }
    if (url.endsWith('/workers/subdomain')) {
      return jsonResponse(overrides.subdomainGet ?? { success: true, result: { subdomain: 'acct-test' } });
    }
    if (url.includes('/workers/scripts')) {
      return jsonResponse(overrides.scripts ?? { success: true, result: [{ id: 'my-site', tag: 'tag-abc-123' }] });
    }
    if (url.includes('/access/identity_providers')) {
      if ((init?.method || 'GET').toUpperCase() === 'POST') {
        return jsonResponse(overrides.idpCreate ?? { success: true, result: { id: 'otp-new' } });
      }
      return jsonResponse(overrides.idps ?? { success: true, result: [{ id: 'otp-123', type: 'onetimepin', name: 'One-time PIN login' }] });
    }
    if (url.includes('/access/apps/')) {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'DELETE') return jsonResponse(overrides.accessDelete ?? { success: true, result: { id: 'app-123' } });
      if (method === 'PUT') return jsonResponse(overrides.accessUpdate ?? { success: true, result: { id: 'app-123' } });
      return jsonResponse(overrides.accessGet ?? { success: true, result: { id: 'app-123' } });
    }
    if (url.includes('/access/apps')) {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'POST') return jsonResponse(overrides.accessCreate ?? { success: true, result: { id: 'app-123', uid: 'app-uid-123' } });
      return jsonResponse(overrides.accessList ?? { success: true, result: [] });
    }
    if (url.endsWith('/user')) {
      return jsonResponse(overrides.user ?? { success: true, result: { email: 'me@example.com' } });
    }
    if (url.includes('/subdomain')) {
      return jsonResponse(overrides.subdomainPost ?? { success: true, result: { enabled: true } });
    }
    return jsonResponse(overrides.scriptPut ?? { success: true, result: {} });
  });
  return { calls, fn };
}

describe('cloudflare-workers access config', () => {
  it('round-trips the access rule', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'od-workers-access-'));
    const prior = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = dir;
    try {
      await writeCloudflareWorkersConfig({
        token: 'tok', accountId: 'acct_test',
        access: { enabled: true, rule: { kind: 'emails', emails: ['a@b.c', 'd@e.f'] } },
      });
      const raw = await readCloudflareWorkersConfig();
      expect(raw.access).toEqual({ enabled: true, rule: { kind: 'emails', emails: ['a@b.c', 'd@e.f'] } });
    } finally {
      process.env.OD_USER_STATE_DIR = prior;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('deployToCloudflareWorkers access (fail-closed)', () => {
  it('creates the Access app before exposing the subdomain', async () => {
    const { calls, fn } = accessFetch();
    vi.stubGlobal('fetch', fn);
    const out = await deployToCloudflareWorkers({
      ...base,
      access: { enabled: true, rule: { kind: 'emails', emails: ['a@b.c'] } },
    });
    const createPos = calls.findIndex((c) => c[0].endsWith('/access/apps') && c[1]?.method === 'POST');
    const exposePos = calls.findIndex((c) => c[0].includes('/subdomain') && c[1]?.method === 'POST');
    expect(createPos).toBeGreaterThanOrEqual(0);
    expect(exposePos).toBeGreaterThan(createPos);

    const createBody = JSON.parse(calls[createPos]![1]?.body as string) as Record<string, unknown>;
    expect(createBody.type).toBe('self_hosted');
    expect(createBody.domain).toBeUndefined();
    expect(createBody.allowed_idps).toEqual(['otp-123']);
    expect(createBody.destinations).toEqual([
      { type: 'worker', worker_id: 'tag-abc-123' },
      { type: 'preview_worker', worker_id: 'tag-abc-123' },
    ]);
    expect(createBody.policies).toEqual([
      { name: 'Allow', decision: 'allow', include: [{ email: { email: 'a@b.c' } }], precedence: 1 },
    ]);
    expect(out.providerMetadata).toMatchObject({ accessProtected: true, accessAppId: 'app-123', createdByOpenDesign: true });
  });

  it('updates the existing app in place when a prior deploy already claimed the Worker', async () => {
    const { calls, fn } = accessFetch({
      accessList: {
        success: true,
        result: [
          {
            id: 'app-existing',
            name: 'my-site (OpenDesign)',
            destinations: [
              { type: 'worker', worker_id: 'tag-abc-123' },
              { type: 'preview_worker', worker_id: 'tag-abc-123' },
            ],
          },
        ],
      },
      accessUpdate: { success: true, result: { id: 'app-existing' } },
    });
    vi.stubGlobal('fetch', fn);
    const out = await deployToCloudflareWorkers({
      ...base,
      access: { enabled: true, rule: { kind: 'emails', emails: ['a@b.c'] } },
    });
    const putCall = calls.find((c) => c[0].includes('/access/apps/app-existing') && c[1]?.method === 'PUT');
    expect(putCall).toBeTruthy();
    const putBody = JSON.parse(putCall![1]?.body as string) as Record<string, unknown>;
    expect(putBody.allowed_idps).toEqual(['otp-123']);
    expect(calls.some((c) => c[0].endsWith('/access/apps') && c[1]?.method === 'POST')).toBe(false);
    expect(out.providerMetadata).toMatchObject({ accessAppId: 'app-existing' });
  });

  it('fails closed when the OTP identity provider cannot be created', async () => {
    const { calls, fn } = accessFetch({
      idps: { success: true, result: [] },
      idpCreate: { success: false, errors: [{ code: 1010, error: 'auth.forbidden' }] },
    });
    vi.stubGlobal('fetch', fn);
    await expect(
      deployToCloudflareWorkers({ ...base, access: { enabled: true, rule: { kind: 'emails', emails: ['a@b.c'] } } }),
    ).rejects.toMatchObject({ name: 'DeployError', code: 'CFW_ACCESS_OTP_SCOPE_REQUIRED' });
    expect(calls.some((c) => c[0].includes('/subdomain') && c[1]?.method === 'POST')).toBe(false);
  });

  it('an Access create failure makes zero exposure calls', async () => {
    const { calls, fn } = accessFetch({
      accessCreate: { success: false, errors: [{ code: 10000, message: 'no permission' }] },
    });
    vi.stubGlobal('fetch', fn);
    await expect(
      deployToCloudflareWorkers({ ...base, access: { enabled: true, rule: { kind: 'self' } } }),
    ).rejects.toBeTruthy();
    expect(calls.some((c) => c[0].includes('/subdomain') && c[1]?.method === 'POST')).toBe(false);
  });

  it('turning access off deletes only the recorded app id', async () => {
    const { calls, fn } = accessFetch();
    vi.stubGlobal('fetch', fn);
    await deployToCloudflareWorkers({ ...base, access: { enabled: false }, priorAccessAppId: 'app-123' });
    const deletes = calls.filter((c) => c[0].includes('/access/apps/') && c[1]?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]![0]).toContain('/access/apps/app-123');
    expect(calls.some((c) => c[0].endsWith('/access/apps') && c[1]?.method === 'POST')).toBe(false);
  });

  it('does not touch Access when disabled and no prior app', async () => {
    const { calls, fn } = accessFetch();
    vi.stubGlobal('fetch', fn);
    await deployToCloudflareWorkers(base);
    expect(calls.some((c) => c[0].includes('/access/apps'))).toBe(false);
  });
});

describe('probeCloudflareWorkersCapabilities access', () => {
  function probeFetch(accessCode: number) {
    const fn = vi.fn(async (url: string) => {
      if (url.includes('/access/apps')) return jsonResponse({ success: false, errors: [{ code: accessCode }] }, 403);
      if (url.includes('/workers/scripts')) return jsonResponse({ success: true, result: [] });
      if (url.includes('/workers/subdomain')) return jsonResponse({ success: true, result: { subdomain: 'acct-test' } });
      if (url.includes('/r2/buckets')) return jsonResponse({ success: false, errors: [{ code: 10042 }] }, 403);
      if (url.includes('/d1/database')) return jsonResponse({ success: false, errors: [{ code: 10000 }] }, 401);
      return jsonResponse({ success: false, errors: [{ code: 10000 }] }, 403);
    });
    return fn;
  }

  it('labels access-not-enabled vs no-permission', async () => {
    vi.stubGlobal('fetch', probeFetch(9999));
    let caps = await probeCloudflareWorkersCapabilities({ token: 'tok', accountId: 'acct_test' });
    expect(caps.access).toBe(false);
    expect(caps.accessReason).toBe('access-not-enabled');

    vi.stubGlobal('fetch', probeFetch(10000));
    caps = await probeCloudflareWorkersCapabilities({ token: 'tok', accountId: 'acct_test' });
    expect(caps.access).toBe(false);
    expect(caps.accessReason).toBe('no-permission');
  });
});

describe('cloudflare access check-link classification', () => {
  it('classifies an Access login redirect as protected', async () => {
    const fn = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://acct-test.cloudflareaccess.com/cdn-cgi/access/login' } }));
    vi.stubGlobal('fetch', fn);
    const result = await checkDeploymentUrl('https://my-site.acct-test.workers.dev');
    expect(result.reachable).toBe(false);
    expect(result.status).toBe('protected');
  });

  it('classifies a connection failure as unreachable, not protected', async () => {
    const fn = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    vi.stubGlobal('fetch', fn);
    const result = await checkDeploymentUrl('https://my-site.acct-test.workers.dev');
    expect(result.reachable).toBe(false);
    expect(result.status).toBeUndefined();
  });

  it('recognizes the Access login page body', () => {
    const resp = new Response('<html>Cloudflare Access</html>', { status: 401 });
    expect(isCloudflareAccessProtectedResponse(resp, '<html>Cloudflare Access login</html>')).toBe(true);
    expect(isCloudflareAccessProtectedResponse(new Response('ok'), 'plain page')).toBe(false);
  });
});
