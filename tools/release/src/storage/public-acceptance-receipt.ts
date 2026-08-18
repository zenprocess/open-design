import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ReleaseTarget } from "@open-design/release";

import { githubInfo, publicUrl, writeJson } from "./common.ts";
import { createPublicColdStartEvidence, parsePublicColdStartEvidence } from "./cold-start-evidence.ts";
import { sha256Digest } from "./latest-publication.ts";
import {
  preparePublicAcceptance,
  publicAcceptanceInternals,
  type PublicAcceptanceCredential,
} from "./public-acceptance.ts";
import { getStorageObject, putStorageObjectWithStatus, type StorageConfig } from "./s3-upload.ts";

type Digest = `sha256:${string}`;

type AcceptanceReceipt = {
  artifact: { digest: string; kind: string; size: number };
  channel: string;
  coldStart: {
    budgetBytes: number;
    components: Record<string, { digest: string; mediaType: string; size: number }>;
    requiredBytes: number;
    target: string;
    timing: PublicAcceptanceCredential["coldStart"]["timing"];
  };
  nodeId: string;
  provenance: Record<string, unknown>;
  recordedAt: string;
  schemaVersion: 1;
  semanticDigest: Digest;
  target: ReleaseTarget;
};

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function validateDigest(value: string): asserts value is Digest {
  if (!digestPattern.test(value)) throw new Error("public acceptance semantic digest must be a lowercase sha256 digest");
}

function receiptObjectKey(channel: string, target: ReleaseTarget, semanticDigest: Digest): string {
  return `${channel}/public-acceptance/content/${target}/${semanticDigest.slice("sha256:".length)}.json`;
}

function semanticColdStart(value: PublicAcceptanceCredential["coldStart"]): AcceptanceReceipt["coldStart"] {
  return {
    budgetBytes: value.budgetBytes,
    components: Object.fromEntries(Object.entries(value.components).sort(([left], [right]) => left.localeCompare(right)).map(([name, artifact]) => [name, {
      digest: artifact.digest,
      mediaType: artifact.mediaType,
      size: artifact.size,
    }])),
    requiredBytes: value.requiredBytes,
    target: value.target,
    timing: value.timing,
  };
}

function stableColdStart(value: AcceptanceReceipt["coldStart"]): Omit<AcceptanceReceipt["coldStart"], "timing"> {
  const { timing: _timing, ...stable } = value;
  return stable;
}

function validateReceipt(value: unknown, expected: { channel: string; semanticDigest: Digest; target: ReleaseTarget }): AcceptanceReceipt {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("public acceptance receipt must be an object");
  const receipt = value as Partial<AcceptanceReceipt>;
  if (
    receipt.schemaVersion !== 1
    || receipt.channel !== expected.channel
    || receipt.semanticDigest !== expected.semanticDigest
    || receipt.target !== expected.target
    || receipt.artifact == null
    || !digestPattern.test(receipt.artifact.digest)
    || typeof receipt.artifact.kind !== "string"
    || receipt.artifact.kind.length === 0
    || !Number.isSafeInteger(receipt.artifact.size)
    || receipt.artifact.size < 1
    || receipt.coldStart == null
    || typeof receipt.nodeId !== "string"
    || receipt.nodeId.length === 0
    || typeof receipt.recordedAt !== "string"
    || !Number.isFinite(Date.parse(receipt.recordedAt))
  ) throw new Error("public acceptance receipt identity mismatch");
  parsePublicColdStartEvidence({
    ...receipt.coldStart,
    components: Object.fromEntries(Object.entries(receipt.coldStart.components).map(([name, artifact]) => [name, {
      ...artifact,
      url: `https://receipt.invalid/${artifact.digest}`,
    }])),
    schemaVersion: 1,
    status: "success",
  });
  return receipt as AcceptanceReceipt;
}

export async function registerPublicAcceptanceReceipt(input: {
  credentialPath: string;
  publicOrigin: string;
  semanticDigest: string;
  storage: StorageConfig;
}): Promise<string> {
  validateDigest(input.semanticDigest);
  const credential = publicAcceptanceInternals.parseCredential(
    JSON.parse(await readFile(input.credentialPath, "utf8")) as unknown,
  );
  if (credential.schemaVersion !== 3) throw new Error("only installed public acceptance can register a content receipt");
  const receipt: AcceptanceReceipt = {
    artifact: { digest: credential.artifact.digest, kind: credential.artifactKind, size: credential.artifact.size },
    channel: credential.closure.channel,
    coldStart: semanticColdStart(credential.coldStart),
    nodeId: `${credential.closure.channel}:${credential.target}:${input.semanticDigest.slice("sha256:".length)}`,
    provenance: githubInfo(),
    recordedAt: credential.acceptedAt,
    schemaVersion: 1,
    semanticDigest: input.semanticDigest,
    target: credential.target,
  };
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const objectKey = receiptObjectKey(receipt.channel, receipt.target, receipt.semanticDigest);
  const result = await putStorageObjectWithStatus({
    ...input.storage,
    body: bytes,
    cacheControl: "public, max-age=31536000, immutable",
    contentType: "application/json; charset=utf-8",
    headers: { "if-none-match": "*" },
    objectKey,
  });
  if (!result.ok) {
    if (result.status !== 412) throw new Error(`public acceptance receipt PUT failed with HTTP ${result.status}: ${result.body}`);
    const existing = await getStorageObject({ ...input.storage, objectKey });
    if (existing == null) throw new Error(`public acceptance receipt disappeared: ${objectKey}`);
    const parsed = validateReceipt(JSON.parse(existing.text) as unknown, {
      channel: receipt.channel,
      semanticDigest: receipt.semanticDigest,
      target: receipt.target,
    });
    if (
      JSON.stringify(parsed.artifact) !== JSON.stringify(receipt.artifact)
      || JSON.stringify(stableColdStart(parsed.coldStart)) !== JSON.stringify(stableColdStart(receipt.coldStart))
    ) throw new Error(`public acceptance receipt conflicts: ${objectKey}`);
  }
  return publicUrl(input.publicOrigin, "", objectKey);
}

export async function projectPublicAcceptance(input: {
  channel: string;
  commit: string;
  credentialDir: string;
  metadataUrl: string;
  publicOrigin: string;
  releaseVersion: string;
  semanticDigests: Partial<Record<ReleaseTarget, string>>;
  storage: StorageConfig;
  workDir: string;
}): Promise<ReleaseTarget[]> {
  const targets = Object.keys(input.semanticDigests).sort() as ReleaseTarget[];
  for (const target of targets) {
    if (target !== "mac_arm64" && target !== "mac_x64" && target !== "win_x64") {
      throw new Error(`unsupported public acceptance receipt target: ${target}`);
    }
    const semanticDigest = input.semanticDigests[target]!;
    validateDigest(semanticDigest);
    const receiptKey = receiptObjectKey(input.channel, target, semanticDigest);
    const object = await getStorageObject({ ...input.storage, objectKey: receiptKey });
    if (object == null) throw new Error(`public acceptance receipt is missing: ${receiptKey}`);
    const receipt = validateReceipt(JSON.parse(object.text) as unknown, { channel: input.channel, semanticDigest, target });
    const namespace = target === "mac_arm64" ? `release-${input.channel}` : target === "mac_x64" ? `release-${input.channel}-x64` : `release-${input.channel}-win`;
    const plan = await preparePublicAcceptance({
      buildJsonPath: `${input.workDir}/${target}-unused-build.json`,
      commit: input.commit,
      downloadDir: `${input.workDir}/${target}`,
      materializeArtifact: false,
      metadataUrl: input.metadataUrl,
      namespace,
      planPath: `${input.workDir}/${target}.plan.json`,
      publicOrigin: input.publicOrigin,
      releaseVersion: input.releaseVersion,
      target,
    });
    const currentColdStart = semanticColdStart(createPublicColdStartEvidence(plan.coldStart, {
      schemaVersion: 1,
      status: "success",
      timing: receipt.coldStart.timing,
    }));
    if (
      receipt.artifact.digest !== plan.artifact.digest
      || receipt.artifact.kind !== plan.artifactKind
      || receipt.artifact.size !== plan.artifact.size
      || JSON.stringify(stableColdStart(receipt.coldStart)) !== JSON.stringify(stableColdStart(currentColdStart))
    ) throw new Error(`public ${target} projection differs from its accepted content receipt`);
    const projection = {
      artifact: plan.artifact,
      closure: plan.closure,
      metadata: plan.metadata,
      platformManifest: plan.platformManifest,
      releaseVersion: plan.releaseVersion,
      target,
    };
    const credential: PublicAcceptanceCredential = {
      acceptedAt: plan.releaseGeneratedAt,
      artifact: { digest: plan.artifact.digest, size: plan.artifact.size, url: plan.artifact.url },
      artifactKind: plan.artifactKind,
      closure: plan.closure,
      coldStart: createPublicColdStartEvidence(plan.coldStart, { schemaVersion: 1, status: "success", timing: receipt.coldStart.timing }),
      commit: plan.commit,
      metadata: { digest: plan.metadata.digest, size: plan.metadata.size, url: plan.metadata.url },
      namespace: plan.namespace,
      platformManifest: { digest: plan.platformManifest.digest, size: plan.platformManifest.size, url: plan.platformManifest.url },
      releaseVersion: plan.releaseVersion,
      schemaVersion: 4,
      status: "accepted",
      target,
      workflowProof: {
        checkedObjects: 3,
        mode: "canonical-receipt-and-public-projection",
        nodeId: receipt.nodeId,
        projectionDigest: `sha256:${createHash("sha256").update(JSON.stringify(projection)).digest("hex")}`,
        receiptDigest: sha256Digest(object.bytes),
        semanticDigest,
        sourceRecordedAt: receipt.recordedAt,
      },
    };
    publicAcceptanceInternals.parseCredential(credential);
    writeJson(`${input.credentialDir}/${target}.json`, credential);
  }
  return targets;
}
