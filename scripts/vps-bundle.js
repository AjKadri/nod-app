#!/usr/bin/env node
"use strict";
/**
 * deploy/vps/setup.sh carries a copy of the relay inside it (a base64 tarball), so it can
 * be sent to a server with one scp. This keeps that copy equal to relay/.
 *
 *   node scripts/vps-bundle.js           rewrite the copy inside setup.sh from relay/
 *   node scripts/vps-bundle.js --check   fail if setup.sh would deploy different relay code
 *
 * `npm test` runs the check, so a relay change cannot ship a stale installer.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "deploy", "vps", "setup.sh");
const FILES = ["server.js", "package.json"];
const PAYLOAD = /echo "([A-Za-z0-9+/=]{200,})" \| base64 -d \| tar -xzf - -C \/opt\/nod-relay --strip-components=1/;

function readPayload() {
  const match = fs.readFileSync(SCRIPT, "utf8").match(PAYLOAD);
  if (!match) throw new Error(`Could not find the embedded relay in ${path.relative(ROOT, SCRIPT)}`);
  return match[1];
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nod-vps-"));
}

function build() {
  const dir = tempDir();
  try {
    const archive = path.join(dir, "relay.tgz");
    execFileSync("tar", ["-czf", archive, "-C", ROOT, ...FILES.map((name) => `relay/${name}`)], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    return fs.readFileSync(archive).toString("base64");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Names of embedded files that differ from relay/ (empty when they match). */
function differences() {
  const dir = tempDir();
  try {
    const archive = path.join(dir, "embedded.tgz");
    fs.writeFileSync(archive, Buffer.from(readPayload(), "base64"));
    execFileSync("tar", ["-xzf", archive, "-C", dir]);
    return FILES.filter((name) => {
      const embedded = path.join(dir, "relay", name);
      return !fs.existsSync(embedded) || !fs.readFileSync(embedded).equals(fs.readFileSync(path.join(ROOT, "relay", name)));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv.includes("--check")) {
  const stale = differences();
  if (stale.length) {
    console.error(`deploy/vps/setup.sh would install an out-of-date relay (${stale.join(", ")}).`);
    console.error("Run: node scripts/vps-bundle.js   and commit the result.");
    process.exit(1);
  }
  console.log("deploy/vps/setup.sh carries the current relay");
} else {
  readPayload(); // fail early if the script no longer has the expected line
  const text = fs.readFileSync(SCRIPT, "utf8").replace(PAYLOAD, (line, old) => line.replace(old, build()));
  fs.writeFileSync(SCRIPT, text);
  console.log(`updated ${path.relative(ROOT, SCRIPT)} from relay/ (${FILES.join(", ")})`);
}
