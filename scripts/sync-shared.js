#!/usr/bin/env node
"use strict";
/**
 * shared/ is the single source of truth for the approval logic. The phone app
 * needs its own copy inside mobile/ because the app bundler only reads files
 * under the app folder. Run `npm run sync` after editing anything in shared/.
 * `npm test` fails if the two copies differ.
 */
const fs = require("fs");
const path = require("path");

const from = path.join(__dirname, "..", "shared");
const to = path.join(__dirname, "..", "mobile", "features", "approvals", "lib");
const check = process.argv.includes("--check");

const files = fs.readdirSync(from).filter((name) => /\.(js|d\.ts)$/.test(name));
const stale = [];
fs.mkdirSync(to, { recursive: true });
for (const name of files) {
  const source = fs.readFileSync(path.join(from, name));
  const target = path.join(to, name);
  const same = fs.existsSync(target) && fs.readFileSync(target).equals(source);
  if (same) continue;
  if (check) stale.push(name);
  else fs.writeFileSync(target, source);
}
const extra = fs.existsSync(to) ? fs.readdirSync(to).filter((name) => !files.includes(name)) : [];
for (const name of extra) {
  if (check) stale.push(`${name} (not in shared/)`);
  else fs.unlinkSync(path.join(to, name));
}

if (check && stale.length > 0) {
  console.error(`mobile copy is out of date: ${stale.join(", ")}. Run: npm run sync`);
  process.exit(1);
}
console.log(check ? "mobile copy matches shared/" : `synced ${files.length} files to mobile/features/approvals/lib`);
