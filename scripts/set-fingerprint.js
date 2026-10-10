#!/usr/bin/env node
"use strict";
/**
 * Publish the release signing key's fingerprint for the Nod web page:
 *
 *   node scripts/set-fingerprint.js AA:BB:...:FF        replace the fingerprint
 *   node scripts/set-fingerprint.js AA:BB:... --add     keep the old ones and add this one
 *
 * Writes site/.well-known/assetlinks.json, then refreshes the copy of the site inside
 * deploy/vps/setup.sh. Commit both, then run setup.sh on the server again.
 * scripts/make-release-key.sh calls this for you.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "site", ".well-known", "assetlinks.json");
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "mobile", "app.json"), "utf8")).expo.android.package;
const FORMAT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

const args = process.argv.slice(2);
const fingerprint = (args.find((a) => !a.startsWith("--")) || "").trim().toUpperCase();
if (!FORMAT.test(fingerprint)) {
  console.error("Give the SHA-256 fingerprint as 32 pairs of hex digits separated by colons, e.g. AB:CD:...");
  process.exit(1);
}
let fingerprints = [fingerprint];
if (args.includes("--add")) {
  const current = JSON.parse(fs.readFileSync(FILE, "utf8"))[0].target.sha256_cert_fingerprints || [];
  fingerprints = [...new Set([...current, fingerprint])];
}
const statement = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: PACKAGE, sha256_cert_fingerprints: fingerprints },
  },
];
fs.writeFileSync(FILE, `${JSON.stringify(statement, null, 2)}\n`);
console.log(`Wrote ${path.relative(ROOT, FILE)} for ${PACKAGE} with ${fingerprints.length} fingerprint(s).`);
execFileSync(process.execPath, [path.join(__dirname, "vps-bundle.js")], { stdio: "inherit" });
