#!/usr/bin/env node
/**
 * Patches wrangler.jsonc before a CI deploy to replace the local Dockerfile
 * path with the pre-built container image tag from the Cloudflare registry.
 *
 * Workers Builds runs in a K8s environment without Docker, so the container
 * image must be built and pushed separately (locally or in a Docker-capable
 * pipeline).  This script:
 *   1. Reads wrangler.jsonc, strips JSONC comments, parses as JSON
 *   2. Queries `wrangler containers images list` for the latest ai-sandbox-chat tag
 *   3. Replaces containers[].image (Dockerfile path) with the registry image ref
 *   4. Writes the patched config to wrangler.deploy.json
 *
 * Deploy command in CI: `node scripts/patch-container-image.js && wrangler deploy --config wrangler.deploy.json`
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const WRANGLER_SRC = "wrangler.jsonc";
const WRANGLER_OUT = "wrangler.deploy.json";
const IMAGE_NAME   = "ai-sandbox-chat";

// Strip JSONC single-line (//) and block (/* */) comments before JSON.parse
function stripJsonc(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/\/\/[^\n]*/g, "");         // line comments
}

const raw    = readFileSync(WRANGLER_SRC, "utf8");
const config = JSON.parse(stripJsonc(raw));

// Query the Cloudflare container registry for the latest image tag
let images;
try {
  const out = execSync(
    `npx wrangler containers images list --json --filter ${IMAGE_NAME}`,
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  images = JSON.parse(out);
} catch (err) {
  console.error(`[patch-container-image] Failed to list container images:\n${err.message}`);
  console.error("Ensure the container image has been built and pushed:");
  console.error("  npm run container:build");
  process.exit(1);
}

// Pick the latest tag (wrangler sorts lexically; date tags like v2025-01-01 sort correctly)
const tag = images?.[0]?.tags?.slice(-1)[0];
if (!tag) {
  console.error(`[patch-container-image] No tags found for image '${IMAGE_NAME}'.`);
  console.error("Build and push the container image first:");
  console.error("  npm run container:build");
  process.exit(1);
}

const acct = config.account_id;
if (!acct) {
  console.error("[patch-container-image] wrangler.jsonc is missing 'account_id'.");
  process.exit(1);
}

// Patch containers[].image for any entry that references the Dockerfile
let patched = 0;
for (const ct of config.containers ?? []) {
  if (typeof ct.image === "string" && ct.image.includes("Dockerfile")) {
    ct.image = `registry.cloudflare.com/${acct}/${IMAGE_NAME}:${tag}`;
    patched++;
  }
}

if (patched === 0) {
  console.warn("[patch-container-image] No Dockerfile reference found in containers[]. Nothing to patch.");
}

writeFileSync(WRANGLER_OUT, JSON.stringify(config, null, 2));
console.log(`[patch-container-image] Container image → ${IMAGE_NAME}:${tag}`);
console.log(`[patch-container-image] Wrote ${WRANGLER_OUT}`);
