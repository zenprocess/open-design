import type { Express } from 'express';
import type { RouteDeps } from '../server-context.js';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { clientRequestIdFor } from '../http/client-request-id.js';
import { classifyDeployFailure } from '../deploy/failure-detail.js';
import { detachCloudflareWorkerDomain, listCloudflareZones } from '../deploy/cloudflare-workers.js';
import { getCloudflareAccessToken } from '../deploy.js';

export interface RegisterDeployRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'ids' | 'deploy' | 'projectStore'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
}

// Resolve the live Cloudflare Workers credential for a route. In oauth mode a
// DeployError from the refresh (CFW_OAUTH_RECONNECT_REQUIRED, …) must reach the
// client as-is: swallowing it into "token required"/"not configured" tells an
// OAuth user to paste an API token.
async function resolveCloudflareWorkersRouteToken(config: { token?: string | undefined; credentialMode?: string | undefined }): Promise<string> {
  if (config.credentialMode === 'oauth') return getCloudflareAccessToken('cloudflare-workers');
  return config.token || '';
}

// Per-project single-flight for Cloudflare Workers deploys: the provider's
// list-then-create steps (Access app, D1, R2) race when two deploys of the same
// project overlap (double-click, agent retry), and the loser fails after its
// script PUT is already live.
const cloudflareWorkersDeploysInFlight = new Map<string, Promise<unknown>>();
export function isCloudflareWorkersDeployInFlight(projectId: string): boolean {
  return cloudflareWorkersDeploysInFlight.has(projectId);
}
async function withCloudflareWorkersDeploySingleFlight<T>(projectId: string, run: () => Promise<T>): Promise<T> {
  if (cloudflareWorkersDeploysInFlight.has(projectId)) {
    throw new DeployErrorLike('A Cloudflare Workers deploy for this project is already in progress.', 409, 'DEPLOY_IN_PROGRESS');
  }
  const p = run();
  cloudflareWorkersDeploysInFlight.set(projectId, p);
  try {
    return await p;
  } finally {
    cloudflareWorkersDeploysInFlight.delete(projectId);
  }
}
class DeployErrorLike extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function registerDeployRoutes(app: Express, ctx: RegisterDeployRoutesDeps) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { PROJECTS_DIR } = ctx.paths;
  const { randomUUID } = ctx.ids;
  const { getProject } = ctx.projectStore;
  const { VERCEL_PROVIDER_ID, CLOUDFLARE_PAGES_PROVIDER_ID, CLOUDFLARE_WORKERS_PROVIDER_ID, isDeployProviderId, publicDeployConfigForProvider, readDeployConfig, writeDeployConfig, listCloudflarePagesZones, DeployError, listDeployments, publicDeployments, getDeployment, buildDeployFileSet, cloudflarePagesProjectNameForDeploy, deployToCloudflarePages, deployToCloudflareWorkers, probeCloudflareWorkersCapabilities, deployToVercel, upsertDeployment, publicDeployment, cloudflarePagesDeploymentMetadata, prepareDeployPreflight } = ctx.deploy;

  /**
   * A DeployError now carries a specific `code` (MISSING_REFERENCES,
   * CF_ASSET_TOO_LARGE, VERCEL_TOKEN_REQUIRED, …). Pass it through instead of
   * flattening every failure to BAD_REQUEST: the client mirrors the envelope
   * code into `artifact_deploy_result.error_code`, so without this every
   * distinct cause — missing token, non-HTML file, unresolved asset reference,
   * oversized asset — collapsed into one opaque HTTP_400 bucket.
   *
   * Provider transport failures deliberately arrive WITHOUT a code (see
   * cloudflareError / vercelError in apps/daemon/src/deploy.ts): they fall back
   * to the generic envelope code so the client keeps bucketing them by the real
   * provider status (HTTP_403 / HTTP_429 / HTTP_502) instead of collapsing
   * auth, quota and upstream faults into one.
   */
  const deployErrorCodeFor = (err: any, status: number): string =>
    (err instanceof DeployError && err.code) ||
    (err instanceof DeployErrorLike && err.code) ||
    (status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST');
  const deployErrorStatus = (err: any): number =>
    err instanceof DeployError || err instanceof DeployErrorLike ? err.status : 400;

  // ---- Deploy --------------------------------------------------------------

  app.get('/api/deploy/config', async (req, res) => {
    try {
      const providerId =
        typeof req.query.providerId === 'string' ? req.query.providerId : VERCEL_PROVIDER_ID;
      if (!isDeployProviderId(providerId)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'unsupported deploy provider');
      }
      /** @type {import('@open-design/contracts').DeployConfigResponse} */
      const body = publicDeployConfigForProvider(providerId, await readDeployConfig(providerId));
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });

  app.put('/api/deploy/config', async (req, res) => {
    try {
      const input = req.body || {};
      const providerId =
        typeof input.providerId === 'string' ? input.providerId : VERCEL_PROVIDER_ID;
      if (!isDeployProviderId(providerId)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'unsupported deploy provider');
      }
      /** @type {import('@open-design/contracts').DeployConfigResponse} */
      const body = await writeDeployConfig(providerId, input);
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, deployErrorCodeFor(err, 400), String(err?.message || err));
    }
  });

  app.get('/api/deploy/cloudflare-pages/zones', async (_req, res) => {
    try {
      /** @type {import('@open-design/contracts').CloudflarePagesZonesResponse} */
      const body = await listCloudflarePagesZones(await readDeployConfig(CLOUDFLARE_PAGES_PROVIDER_ID));
      res.json(body);
    } catch (err: any) {
      const status = err instanceof DeployError ? err.status : 400;
      const init =
        err instanceof DeployError && err.details
          ? { details: err.details }
          : {};
      sendApiError(res, status, deployErrorCodeFor(err, status), String(err?.message || err), init);
    }
  });

  app.get('/api/deploy/cloudflare-workers/capabilities', async (_req, res) => {
    try {
      const config = await readDeployConfig(CLOUDFLARE_WORKERS_PROVIDER_ID);
      const empty = { workers: false, workersDevSubdomain: '', r2: false, d1: false, access: false, configured: false };
      if (!config?.accountId) {
        res.json(empty);
        return;
      }
      const token = await resolveCloudflareWorkersRouteToken(config);
      if (!token) {
        res.json(empty);
        return;
      }
      const caps = await probeCloudflareWorkersCapabilities({ token, accountId: config.accountId });
      res.json({ ...caps, configured: true });
    } catch (err: any) {
      const status = err instanceof DeployError ? err.status : 400;
      sendApiError(res, status, deployErrorCodeFor(err, status), String(err?.message || err));
    }
  });

  app.get('/api/deploy/cloudflare-workers/zones', async (_req, res) => {
    try {
      const config = await readDeployConfig(CLOUDFLARE_WORKERS_PROVIDER_ID);
      // `/zones?account.id=` (empty) lists every zone the token can see, across
      // accounts; a picked foreign zone then fails at attach. Require the account.
      if (!config.accountId) {
        return sendApiError(res, 400, 'CFW_ACCOUNT_ID_REQUIRED', 'Cloudflare account ID is required.');
      }
      const token = await resolveCloudflareWorkersRouteToken(config);
      if (!token) {
        res.json({ zones: [] });
        return;
      }
      const zones = await listCloudflareZones({ token, accountId: config.accountId });
      res.json({ zones });
    } catch (err: any) {
      const status = err instanceof DeployError ? err.status : 400;
      sendApiError(res, status, deployErrorCodeFor(err, status), String(err?.message || err));
    }
  });

  app.delete('/api/deploy/cloudflare-workers/domains/:domainId', async (req, res) => {
    try {
      const config = await readDeployConfig(CLOUDFLARE_WORKERS_PROVIDER_ID);
      if (!config.accountId) {
        return sendApiError(res, 400, 'CFW_ACCOUNT_ID_REQUIRED', 'Cloudflare account ID is required.');
      }
      // Mirror the capabilities/zones token resolution: oauth refreshes the
      // rotating access token, token mode reads the configured static token.
      const token = await resolveCloudflareWorkersRouteToken(config);
      if (!token) {
        return sendApiError(res, 400, 'CFW_TOKEN_REQUIRED', 'Cloudflare API token is required.');
      }
      const deleted = await detachCloudflareWorkerDomain({ token, accountId: config.accountId }, req.params.domainId);
      res.json(deleted ? { ok: true } : { ok: true, deleted: false });
    } catch (err: any) {
      const status = err instanceof DeployError ? err.status : 400;
      sendApiError(res, status, deployErrorCodeFor(err, status), String(err?.message || err));
    }
  });

  app.get('/api/projects/:id/deployments', async (req, res) => {
    try {
      if (!getProject(db, req.params.id)) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      if (!await ctx.authorizeProjectRequest(req, res, req.params.id, { mode: 'read' })) return;
      /** @type {import('@open-design/contracts').ProjectDeploymentsResponse} */
      const body = { deployments: publicDeployments(listDeployments(db, req.params.id)) };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.post('/api/projects/:id/deploy', async (req, res) => {
    const startedAt = Date.now();
    let stage: 'file_plan' | 'provider' = 'file_plan';
    try {
      const { fileName, providerId = VERCEL_PROVIDER_ID, cloudflarePages, target: rawTarget } = req.body || {};
      // Omitted target defaults to production; any supplied value must be exact.
      if (rawTarget !== undefined && rawTarget !== 'preview' && rawTarget !== 'production') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'invalid target: expected "preview" or "production"');
      }
      const target: 'preview' | 'production' = rawTarget === 'preview' ? 'preview' : 'production';
      // Vercel production-target deploys are out of scope for this PR (P2 review
      // finding on PR #4576) — deployToVercel() never receives `target` and
      // always behaves as preview, so an explicit target=production request
      // must be rejected before any deploy call instead of silently deploying
      // as preview. Only the explicitly-supplied raw value gates this: the
      // omitted-target default (which resolves to 'production' above for
      // Cloudflare Pages parity) must keep deploying Vercel as before.
      if (providerId === VERCEL_PROVIDER_ID && rawTarget === 'production') {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          'Vercel does not support target=production yet; use target=preview or omit target',
        );
      }
      if (!isDeployProviderId(providerId)) {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          'unsupported deploy provider',
        );
      }
      if (typeof fileName !== 'string' || !fileName.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'fileName required');
      }
      const deployProject = getProject(db, req.params.id);
      if (!deployProject) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      if (!await ctx.authorizeProjectRequest(
        req,
        res,
        req.params.id,
        { mode: 'write', capability: 'writeFiles' },
      )) return;

      const prior = getDeployment(db, req.params.id, fileName, providerId);
      const files = await buildDeployFileSet(
        PROJECTS_DIR,
        req.params.id,
        fileName,
        { metadata: deployProject?.metadata, includeProjectFiles: true },
      );
      const project = getProject(db, req.params.id);
      stage = 'provider';
      const cloudflarePagesProjectName =
        providerId === CLOUDFLARE_PAGES_PROVIDER_ID
          ? cloudflarePagesProjectNameForDeploy(db, req.params.id, project?.name, prior)
          : '';
      const workersConfig = providerId === CLOUDFLARE_WORKERS_PROVIDER_ID
        ? await readDeployConfig(CLOUDFLARE_WORKERS_PROVIDER_ID)
        : undefined;
      // The single-flight guard for Workers is armed before the file plan/CF
      // calls of a second overlapping deploy can run, so the loser is refused
      // up front instead of after its script PUT.
      const result = providerId === CLOUDFLARE_PAGES_PROVIDER_ID
        ? await deployToCloudflarePages({
            config: {
              ...await readDeployConfig(CLOUDFLARE_PAGES_PROVIDER_ID),
              projectName: cloudflarePagesProjectName,
            },
            files,
            projectId: req.params.id,
            cloudflarePages,
            priorMetadata: prior?.providerMetadata,
            target,
          })
        : providerId === CLOUDFLARE_WORKERS_PROVIDER_ID
          ? await withCloudflareWorkersDeploySingleFlight(req.params.id, () => deployToCloudflareWorkers({
              config: workersConfig!,
              files,
              projectId: req.params.id,
              projectName: project?.name,
              target,
              customDomain: workersConfig?.customDomain,
              access: workersConfig?.access,
              priorAccessAppId:
                typeof prior?.providerMetadata?.accessAppId === 'string'
                  ? prior.providerMetadata.accessAppId
                  : undefined,
            }))
          : await deployToVercel({
              config: await readDeployConfig(VERCEL_PROVIDER_ID),
              files,
              projectId: req.params.id,
            });
      const now = Date.now();
      /** @type {import('@open-design/contracts').DeployProjectFileResponse} */
      const body = upsertDeployment(db, {
        id: prior?.id ?? randomUUID(),
        projectId: req.params.id,
        fileName,
        providerId,
        url: result.url,
        deploymentId: result.deploymentId,
        deploymentCount: (prior?.deploymentCount ?? 0) + 1,
        target: result.target ?? target,
        status: result.status,
        statusMessage: result.statusMessage,
        reachableAt: result.reachableAt,
        cloudflarePages: result.cloudflarePages,
        // providerMetadata is stripped by publicDeployment, so surface the
        // Workers result (accessProtected/steps/check/customDomain) in a field
        // that survives to the client.
        cloudflareWorkers:
          providerId === CLOUDFLARE_WORKERS_PROVIDER_ID
            ? (result.providerMetadata as unknown as import('@open-design/contracts').CloudflareWorkersDeploymentInfo | undefined)
            : undefined,
        providerMetadata:
          providerId === CLOUDFLARE_PAGES_PROVIDER_ID
            ? (result.providerMetadata ?? cloudflarePagesDeploymentMetadata(cloudflarePagesProjectName))
            : providerId === CLOUDFLARE_WORKERS_PROVIDER_ID
              ? result.providerMetadata
              : prior?.providerMetadata,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      });
      res.json(publicDeployment(body));
    } catch (err: any) {
      const status = deployErrorStatus(err);
      const code = deployErrorCodeFor(err, status);
      const failure = classifyDeployFailure(stage, err, err instanceof DeployError || err instanceof DeployErrorLike);
      const requestId = clientRequestIdFor(req);
      // Structured companion to the response: automatic diagnostics bundles
      // include the daemon log, and `requestId` joins it to the client event.
      console.warn('[od] deploy failure', JSON.stringify({
        providerId: typeof req.body?.providerId === 'string' ? req.body.providerId : VERCEL_PROVIDER_ID,
        status,
        errorCode: code,
        ...failure,
        ...(requestId ? { requestId } : {}),
        durationMs: Math.max(0, Date.now() - startedAt),
      }));
      const init =
        err instanceof DeployError && err.details
          ? { details: err.details, failure }
          : { failure };
      sendApiError(
        res,
        status,
        code,
        String(err?.message || err),
        init,
      );
    }
  });

  app.post('/api/projects/:id/deploy/preflight', async (req, res) => {
    try {
      const { fileName, providerId = VERCEL_PROVIDER_ID } = req.body || {};
      if (!isDeployProviderId(providerId)) {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          'unsupported deploy provider',
        );
      }
      if (typeof fileName !== 'string' || !fileName.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'fileName required');
      }
      const preflightProject = getProject(db, req.params.id);
      if (!await ctx.authorizeProjectRequest(req, res, req.params.id, { mode: 'read' })) return;
      /** @type {import('@open-design/contracts').DeployPreflightResponse} */
      const body = await prepareDeployPreflight(
        PROJECTS_DIR,
        req.params.id,
        fileName,
        { metadata: preflightProject?.metadata, providerId, includeProjectFiles: true },
      );
      res.json(body);
    } catch (err: any) {
      // DeployError is a known/expected outcome (validation, missing file).
      // Anything else points at a bug or an unexpected runtime state, so
      // surface it in the daemon log without leaking internals to the
      // client which still gets a generic 400.
      if (!(err instanceof DeployError)) {
        console.error('[deploy/preflight]', err);
      }
      const status = err instanceof DeployError ? err.status : 400;
      sendApiError(
        res,
        status,
        deployErrorCodeFor(err, status),
        String(err?.message || err),
      );
    }
  });

}

export interface RegisterDeploymentCheckRoutesDeps extends RouteDeps<'db' | 'http' | 'deploy' | 'projectStore'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
}

export function registerDeploymentCheckRoutes(app: Express, ctx: RegisterDeploymentCheckRoutesDeps) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { getProject } = ctx.projectStore;
  const { getDeploymentById, CLOUDFLARE_PAGES_PROVIDER_ID, cloudflarePagesProjectNameFromDeployment, checkCloudflarePagesDeploymentLinks, checkDeploymentUrl, upsertDeployment, publicDeployment } = ctx.deploy;

  app.post(
    '/api/projects/:id/deployments/:deploymentId/check-link',
    async (req, res) => {
      try {
        if (!getProject(db, req.params.id)) {
          return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        }
        if (!await ctx.authorizeProjectRequest(
          req,
          res,
          req.params.id,
          { mode: 'write', capability: 'writeFiles' },
        )) return;
        const existing = getDeploymentById(
          db,
          req.params.id,
          req.params.deploymentId,
        );
        if (!existing) {
          return sendApiError(
            res,
            404,
            'FILE_NOT_FOUND',
            'deployment not found',
          );
        }
        const stableCloudflareProjectName =
          existing.providerId === CLOUDFLARE_PAGES_PROVIDER_ID
            ? cloudflarePagesProjectNameFromDeployment(existing)
            : '';
        if (existing.providerId === CLOUDFLARE_PAGES_PROVIDER_ID && existing.cloudflarePages?.pagesDev?.url) {
          const checked = await checkCloudflarePagesDeploymentLinks(existing);
          const now = Date.now();
          /** @type {import('@open-design/contracts').CheckDeploymentLinkResponse} */
          const body = upsertDeployment(db, {
            ...existing,
            ...checked,
            reachableAt: checked.status === 'ready' ? now : existing.reachableAt,
            updatedAt: now,
          });
          return res.json(publicDeployment(body));
        }
        const checkUrl = stableCloudflareProjectName
          ? `https://${stableCloudflareProjectName}.pages.dev`
          : existing.url;
        const result = await checkDeploymentUrl(checkUrl);
        const now = Date.now();
        /** @type {import('@open-design/contracts').CheckDeploymentLinkResponse} */
        const body = upsertDeployment(db, {
          ...existing,
          url: checkUrl || existing.url,
          status: result.reachable ? 'ready' : result.status || 'link-delayed',
          statusMessage: result.reachable
            ? 'Public link is ready.'
            : result.statusMessage ||
              'Vercel is still preparing the public link.',
          reachableAt: result.reachable ? now : existing.reachableAt,
          updatedAt: now,
        });
        res.json(publicDeployment(body));
      } catch (err: any) {
        sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
      }
    },
  );

}
