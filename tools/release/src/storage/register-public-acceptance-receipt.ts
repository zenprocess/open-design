import { required, storageConfigFromEnv } from "./common.ts";
import { registerPublicAcceptanceReceipt } from "./public-acceptance-receipt.ts";

const url = await registerPublicAcceptanceReceipt({
  credentialPath: required("RELEASE_PUBLIC_ACCEPTANCE_CREDENTIAL_PATH"),
  publicOrigin: required("RELEASE_PUBLIC_ORIGIN"),
  semanticDigest: required("RELEASE_PUBLIC_ACCEPTANCE_SEMANTIC_DIGEST"),
  storage: storageConfigFromEnv(),
});
console.log(url);
