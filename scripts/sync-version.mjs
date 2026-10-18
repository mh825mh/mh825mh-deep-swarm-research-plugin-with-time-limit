#!/usr/bin/env node
/**
 * @file scripts/sync-version.mjs
 * Keeps package.json `version` and manifest.json `revision` from drifting.
 *
 * `revision` is an independent monotonic integer used by LM Studio to detect a
 * changed plugin bundle, so it is derived deterministically from the semver
 * version instead of being hand-maintained:
 *
 *   revision = major * 10000 + minor * 100 + patch
 *
 * With --fix (or when run without --check) the manifest is rewritten. Without
 * --fix the script only reports drift and exits non-zero so a prebuild step can
 * fail loudly. Pass --warn to downgrade a mismatch to a warning.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const manifestPath = join(root, "manifest.json");

const args = new Set(process.argv.slice(2));
const fix = args.has("--fix");
const warnOnly = args.has("--warn");

function revisionFromVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!m) return null;
  const [, major, minor, patch] = m;
  return Number(major) * 10_000 + Number(minor) * 100 + Number(patch);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const version = pkg.version;
const expected = revisionFromVersion(version);
const actual = manifest.revision;

if (expected === null) {
  console.warn(`[sync-version] package.json version "${version}" is not semver — skipping.`);
  process.exit(0);
}

if (actual === expected) {
  console.log(`[sync-version] version ${version} ↔ revision ${actual} in sync.`);
  process.exit(0);
}

const message =
  `[sync-version] version ${version} expects manifest revision ${expected}, ` +
  `found ${actual} (out of sync).`;

if (fix) {
  manifest.revision = expected;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`${message} Auto-incremented revision → ${expected}.`);
  process.exit(0);
}

if (warnOnly) {
  console.warn(`${message} Run "node scripts/sync-version.mjs --fix" to update.`);
  process.exit(0);
}

console.error(`${message} Run "node scripts/sync-version.mjs --fix" to update.`);
process.exit(1);
