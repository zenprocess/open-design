import { required, storageConfigFromEnv } from "./common.ts";
import { projectPublicAcceptance } from "./public-acceptance-receipt.ts";

const semanticDigests = JSON.parse(required("RELEASE_PUBLIC_ACCEPTANCE_REUSE_JSON")) as Record<string, string>;
const targets = await projectPublicAcceptance({
  channel: required("RELEASE_CHANNEL"),
  commit: required("RELEASE_COMMIT"),
  credentialDir: required("RELEASE_PUBLIC_ACCEPTANCE_CREDENTIAL_DIR"),
  metadataUrl: required("RELEASE_METADATA_URL"),
  publicOrigin: required("RELEASE_PUBLIC_ORIGIN"),
  releaseVersion: required("RELEASE_VERSION"),
  semanticDigests,
  storage: storageConfigFromEnv(),
  workDir: required("RELEASE_PUBLIC_ACCEPTANCE_WORK_DIR"),
});
console.log(`projected public acceptance credentials: ${targets.join(", ") || "none"}`);
