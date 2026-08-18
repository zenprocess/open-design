import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLOSURE_DISTRIBUTION_CONTRIBUTION_SCHEMA_VERSION,
  CLOSURE_PROTOCOL_VERSION,
} from "@open-design/closure/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClosureContributionPublicationPlan, publishClosureContribution } from "../src/storage/publish-closure-contribution.js";

const roots: string[] = [];

function digest(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "od-closure-publish-plan-"));
  roots.push(root);
  const blobRoot = join(root, "blobs");
  await mkdir(blobRoot);
  const launcherBytes = Buffer.from("launcher");
  const bodyBytes = Buffer.from("body");
  const launcher = digest(launcherBytes);
  const body = digest(bodyBytes);
  await Promise.all([
    writeFile(join(blobRoot, launcher.slice("sha256:".length)), launcherBytes),
    writeFile(join(blobRoot, body.slice("sha256:".length)), bodyBytes),
  ]);
  const artifact = (value: `sha256:${string}`, size: number) => ({
    digest: value,
    mediaType: "application/zip",
    size,
    url: `https://releases.open-design.test/beta/versions/0.19.0-beta.9/closure/blobs/${value.slice("sha256:".length)}`,
  });
  const contribution = {
    body: { artifact: artifact(body, bodyBytes.byteLength), entryPath: "bootloader.mjs", treeDigest: digest("body tree") },
    channel: "beta",
    launcher: {
      artifact: artifact(launcher, launcherBytes.byteLength),
      entryPath: "launcher.mjs",
      handoffPath: "bootloader.mjs",
      treeDigest: digest("launcher tree"),
    },
    protocolVersion: CLOSURE_PROTOCOL_VERSION,
    resources: [],
    schemaVersion: CLOSURE_DISTRIBUTION_CONTRIBUTION_SCHEMA_VERSION,
    shellCompatibility: { electron: { version: { min: "0.19.0-beta.1" } } },
    version: "0.19.0-beta.9",
  };
  return { blobRoot, body, contribution, launcher };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const name of [
    "RELEASE_CHANNEL",
    "RELEASE_CLOSURE_BLOB_ROOT",
    "RELEASE_CLOSURE_BUILD_DIGEST",
    "RELEASE_CLOSURE_BUILD_KIND",
    "RELEASE_CLOSURE_BUILD_TOKEN",
    "RELEASE_CLOSURE_CONTRIBUTION_JSON_PATH",
    "RELEASE_CLOSURE_CONTRIBUTION_KIND",
    "RELEASE_CLOSURE_REMOTE_PROJECTION",
    "RELEASE_PUBLIC_ORIGIN",
    "RELEASE_STORAGE_ACCESS_KEY_ID",
    "RELEASE_STORAGE_BUCKET",
    "RELEASE_STORAGE_ENDPOINT",
    "RELEASE_STORAGE_REGION",
    "RELEASE_STORAGE_SECRET_ACCESS_KEY",
    "RELEASE_VERSION",
  ]) delete process.env[name];
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })));
});

describe("Closure contribution publication boundary", () => {
  it("binds protocol-declared CAS objects to locally verified bytes", async () => {
    const value = await fixture();
    const plan = createClosureContributionPublicationPlan({
      blobRoot: value.blobRoot,
      channel: "beta",
      contribution: value.contribution,
      kind: "shared",
      publicOrigin: "https://releases.open-design.test",
      version: "0.19.0-beta.9",
    });
    expect(plan.blobs.map(({ digest: value }) => value)).toEqual([value.launcher, value.body]);
    expect(plan.blobs[0]?.objectKey).toBe(
      `beta/versions/0.19.0-beta.9/closure/blobs/${value.launcher.slice("sha256:".length)}`,
    );
  });

  it("publishes target-native and target-scoped resource blobs together", async () => {
    const value = await fixture();
    const resourceBytes = Buffer.from("vela-runtime");
    const resource = digest(resourceBytes);
    await writeFile(join(value.blobRoot, resource.slice("sha256:".length)), resourceBytes);
    const native = value.contribution.body.artifact;
    const contribution = {
      channel: "beta",
      native: { artifact: native, treeDigest: digest("native tree") },
      protocolVersion: CLOSURE_PROTOCOL_VERSION,
      resources: [{
        artifact: {
          digest: resource,
          mediaType: "application/zip",
          size: resourceBytes.byteLength,
          url: `https://releases.open-design.test/beta/versions/0.19.0-beta.9/closure/blobs/${resource.slice("sha256:".length)}`,
        },
        id: "vela-runtime",
        startup: "blocking",
        title: "Vela runtime",
        treeDigest: digest("vela tree"),
      }],
      schemaVersion: CLOSURE_DISTRIBUTION_CONTRIBUTION_SCHEMA_VERSION,
      target: "darwin-arm64",
      version: "0.19.0-beta.9",
    };
    const plan = createClosureContributionPublicationPlan({
      blobRoot: value.blobRoot,
      channel: "beta",
      contribution,
      kind: "target",
      publicOrigin: "https://releases.open-design.test",
      version: "0.19.0-beta.9",
    });

    expect(plan.blobs.map((entry) => entry.digest)).toEqual([native.digest, resource]);
  });

  it("rejects cross-release contributions before storage access", async () => {
    const value = await fixture();
    expect(() => createClosureContributionPublicationPlan({
      blobRoot: value.blobRoot,
      channel: "beta",
      contribution: value.contribution,
      kind: "shared",
      publicOrigin: "https://releases.open-design.test",
      version: "0.19.0-beta.10",
    })).toThrow(/identity/u);
  });

  it("rejects local byte drift and URL drift", async () => {
    const value = await fixture();
    await writeFile(join(value.blobRoot, value.body.slice("sha256:".length)), "drift");
    expect(() => createClosureContributionPublicationPlan({
      blobRoot: value.blobRoot,
      channel: "beta",
      contribution: value.contribution,
      kind: "shared",
      publicOrigin: "https://releases.open-design.test",
      version: "0.19.0-beta.9",
    })).toThrow(/digest verification/u);

    const next = await fixture();
    next.contribution.body.artifact.url = "https://example.test/body.zip";
    expect(() => createClosureContributionPublicationPlan({
      blobRoot: next.blobRoot,
      channel: "beta",
      contribution: next.contribution,
      kind: "shared",
      publicOrigin: "https://releases.open-design.test",
      version: "0.19.0-beta.9",
    })).toThrow(/blob URL/u);
  });

  it("projects a rebound contribution directly from its immutable build record", async () => {
    const value = await fixture();
    const root = roots.at(-1)!;
    const identityDigest = digest("shared identity");
    const contributionPath = join(root, "projected-contribution.json");
    await writeFile(contributionPath, `${JSON.stringify(value.contribution)}\n`);
    const buildPrefix = `beta/closure/builds/shared/${identityDigest.slice("sha256:".length)}`;
    const record = {
      artifacts: [value.contribution.launcher.artifact, value.contribution.body.artifact].map((artifact) => ({
        ...artifact,
        objectKey: `${buildPrefix}/blobs/${artifact.digest.slice("sha256:".length)}`,
      })),
      channel: "beta",
      contribution: value.contribution,
      createdAt: new Date().toISOString(),
      identityDigest,
      kind: "shared",
      provenance: {},
      schemaVersion: 1,
    };
    const copies: Array<{ source: string; target: string }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const key = url.pathname.replace(/^\/releases\//u, "");
      if (init?.method === "PUT") {
        const headers = new Headers(init.headers);
        copies.push({ source: headers.get("x-amz-copy-source") ?? "", target: key });
        return new Response("", { status: 200 });
      }
      if (key === `${buildPrefix}/record.json`) {
        return new Response(JSON.stringify(record), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    Object.assign(process.env, {
      RELEASE_CHANNEL: "beta",
      RELEASE_CLOSURE_BLOB_ROOT: join(root, "unused"),
      RELEASE_CLOSURE_BUILD_DIGEST: identityDigest,
      RELEASE_CLOSURE_BUILD_KIND: "shared",
      RELEASE_CLOSURE_BUILD_TOKEN: "shared",
      RELEASE_CLOSURE_CONTRIBUTION_JSON_PATH: contributionPath,
      RELEASE_CLOSURE_CONTRIBUTION_KIND: "shared",
      RELEASE_CLOSURE_REMOTE_PROJECTION: "true",
      RELEASE_PUBLIC_ORIGIN: "https://releases.open-design.test",
      RELEASE_STORAGE_ACCESS_KEY_ID: "test-key",
      RELEASE_STORAGE_BUCKET: "releases",
      RELEASE_STORAGE_ENDPOINT: "https://storage.example",
      RELEASE_STORAGE_REGION: "auto",
      RELEASE_STORAGE_SECRET_ACCESS_KEY: "test-secret",
      RELEASE_VERSION: "0.19.0-beta.9",
    });

    await publishClosureContribution();

    expect(copies).toHaveLength(2);
    expect(copies.map(({ target }) => target)).toEqual([
      `beta/versions/0.19.0-beta.9/closure/blobs/${value.launcher.slice("sha256:".length)}`,
      `beta/versions/0.19.0-beta.9/closure/blobs/${value.body.slice("sha256:".length)}`,
    ]);
    expect(copies.every(({ source }) => source.startsWith("/releases/beta/closure/builds/shared/"))).toBe(true);
  });
});
