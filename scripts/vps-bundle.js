#!/usr/bin/env node
"use strict";
/**
 * deploy/vps/setup.sh carries a copy of the relay and of the site inside it (base64 tarballs), so it
 * can be sent to a server with one scp. This keeps both copies equal to the repo.
 *
 *   node scripts/vps-bundle.js           rewrite the copies inside setup.sh from relay/ and site/
 *   node scripts/vps-bundle.js --check   fail if setup.sh would deploy different relay or site files
 *
 * `npm test` and CI run the check, so a relay or site change cannot ship a stale installer.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "deploy", "vps", "setup.sh");

// What goes into each tarball, and the line in setup.sh that unpacks it.
const PAYLOADS = [
  {
    name: "relay",
    dir: "relay",
    files: () => ["server.js", "package.json"],
    pattern: /echo "([A-Za-z0-9+/=]{200,})" \| base64 -d \| tar -xzf - -C \/opt\/nod-relay --strip-components=1/,
  },
  {
    name: "site",
    dir: "site",
    files: () => listFiles(path.join(ROOT, "site")),
    pattern: /echo "([A-Za-z0-9+/=]{200,})" \| base64 -d \| tar -xzf - -C "\$SITE_DIR" --strip-components=1/,
  },
];

/** Every file under `dir`, as paths relative to it, dotfolders included (.well-known). */
function listFiles(dir, prefix = "") {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? listFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    )
    .sort();
}

function readPayload(payload) {
  const match = fs.readFileSync(SCRIPT, "utf8").match(payload.pattern);
  if (!match) throw new Error(`Could not find the embedded ${payload.name} in ${path.relative(ROOT, SCRIPT)}`);
  return match[1];
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nod-vps-"));
}

function build(payload) {
  const dir = tempDir();
  try {
    const archive = path.join(dir, "bundle.tgz");
    execFileSync("tar", ["-czf", archive, "-C", ROOT, ...payload.files().map((name) => `${payload.dir}/${name}`)], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    return fs.readFileSync(archive).toString("base64");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Files that differ between the embedded copy and the repo, or exist on only one side. */
function differences(payload) {
  const dir = tempDir();
  try {
    const archive = path.join(dir, "embedded.tgz");
    fs.writeFileSync(archive, Buffer.from(readPayload(payload), "base64"));
    execFileSync("tar", ["-xzf", archive, "-C", dir]);
    const embeddedDir = path.join(dir, payload.dir);
    const embedded = fs.existsSync(embeddedDir) ? listFiles(embeddedDir) : [];
    const expected = payload.files();
    const names = [...new Set([...embedded, ...expected])].sort();
    return names.filter((name) => {
      const inEmbedded = path.join(embeddedDir, name);
      const inRepo = path.join(ROOT, payload.dir, name);
      return !embedded.includes(name) || !expected.includes(name) || !fs.readFileSync(inEmbedded).equals(fs.readFileSync(inRepo));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv.includes("--check")) {
  let failed = false;
  for (const payload of PAYLOADS) {
    const stale = differences(payload);
    if (stale.length) {
      failed = true;
      console.error(`deploy/vps/setup.sh would install an out-of-date ${payload.name} (${stale.join(", ")}).`);
    }
  }
  if (failed) {
    console.error("Run: node scripts/vps-bundle.js   and commit the result.");
    process.exit(1);
  }
  console.log("deploy/vps/setup.sh carries the current relay and site");
} else {
  let text = fs.readFileSync(SCRIPT, "utf8");
  for (const payload of PAYLOADS) {
    readPayload(payload); // fail early if the script no longer has the expected line
    text = text.replace(payload.pattern, (line, old) => line.replace(old, build(payload)));
  }
  fs.writeFileSync(SCRIPT, text);
  console.log(`updated ${path.relative(ROOT, SCRIPT)} from ${PAYLOADS.map((p) => `${p.dir}/`).join(" and ")}`);
}
