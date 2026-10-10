"use strict";
/**
 * Release pieces that can be checked without a phone: the icon and splash settings, the release
 * signing patch, the wallet identity, the web page and what the installer deploys.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const app = JSON.parse(read("mobile", "app.json")).expo;
const png = (file) => fs.readFileSync(path.join(ROOT, file));

function pngSize(buffer) {
  assert.equal(buffer.subarray(1, 4).toString(), "PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// ---------------------------------------------------------------- icon and splash

test("icon: solid #151816 adaptive background, foreground and monochrome inside the safe zone, no template images", () => {
  const icon = app.android.adaptiveIcon;
  assert.equal(icon.backgroundColor, "#151816");
  assert.equal(icon.backgroundImage, undefined, "a solid colour, not an image");
  for (const key of ["foregroundImage", "monochromeImage"]) {
    const file = path.join("mobile", icon[key]);
    assert.deepEqual(pngSize(png(file)), { width: 1024, height: 1024 }, key);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, "mobile/assets/images/android-icon-background.png")));
  assert.deepEqual(pngSize(png("mobile/assets/images/icon.png")), { width: 1024, height: 1024 });
});

/** Alpha channel of an 8-bit RGBA, non-interlaced PNG, without a library. */
function alphaOf(buffer) {
  const zlib = require("node:zlib");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assert.equal(buffer[24], 8, "8 bits per channel");
  assert.equal(buffer[25], 6, "RGBA");
  assert.equal(buffer[28], 0, "not interlaced");
  const chunks = [];
  for (let at = 8; at < buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    if (buffer.subarray(at + 4, at + 8).toString() === "IDAT") chunks.push(buffer.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i += 1) {
      const value = raw[y * (stride + 1) + 1 + i];
      const left = i >= 4 ? pixels[y * stride + i - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= 4 ? pixels[(y - 1) * stride + i - 4] : 0;
      const paeth = () => {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      };
      const predictor = [0, left, up, (left + up) >> 1, paeth()][filter];
      pixels[y * stride + i] = (value + predictor) & 255;
    }
  }
  return { width, height, alpha: (x, y) => pixels[y * stride + x * 4 + 3] };
}

test("icon: the drawn letter stays inside the 66dp circle that every launcher shape shows", () => {
  for (const name of ["android-icon-foreground.png", "android-icon-monochrome.png"]) {
    const { width, height, alpha } = alphaOf(png(`mobile/assets/images/${name}`));
    const radius = (width * 66) / 108 / 2;
    let drawn = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (alpha(x, y) > 8) {
          drawn += 1;
          assert.ok(Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) <= radius, `${name}: pixel ${x},${y} is outside the safe zone`);
        }
      }
    }
    assert.ok(drawn > 10_000, `${name} has something drawn in it`);
  }
});

test("splash: #151816 in light and dark, the same wordmark image, sized for Android 12's circle", () => {
  const entry = app.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === "expo-splash-screen");
  assert.ok(entry);
  const config = entry[1];
  assert.equal(config.backgroundColor, "#151816");
  assert.equal(config.dark.backgroundColor, "#151816");
  assert.equal(config.image, "./assets/images/splash-icon.png");
  const { width, height } = pngSize(png("mobile/assets/images/splash-icon.png"));
  assert.equal(width, height, "square: Android 12 draws it inside a square icon area");
  assert.equal(width, 1152, "288dp at 4x");
});

test("notifications: a small monochrome icon, so alerts do not show a white square", () => {
  const entry = app.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === "expo-notifications");
  assert.equal(entry[1].icon, "./assets/images/notification-icon.png");
  assert.ok(fs.existsSync(path.join(ROOT, "mobile", entry[1].icon)));
});

// ---------------------------------------------------------------- release signing

const TEMPLATE = `
android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}
`;

test("signing: the release build uses the release key when it is provided and the debug key otherwise", () => {
  const { patchBuildGradle } = require("../mobile/plugins/with-release-signing");
  const patched = patchBuildGradle(TEMPLATE);
  assert.match(patched, /signingConfigs \{\n {8}release \{[\s\S]*?System\.getenv\('NOD_KEYSTORE_PATH'\)/);
  assert.match(patched, /release \{\n(?:\s*\/\/[^\n]*\n)*\s*signingConfig System\.getenv\('NOD_KEYSTORE_PATH'\) \? signingConfigs\.release : signingConfigs\.debug/);
  assert.match(patched, /debug \{\n\s*signingConfig signingConfigs\.debug/, "debug builds are untouched");
  assert.equal(patchBuildGradle(patched), patched, "patching twice changes nothing");
  assert.ok(!/storePassword '[^a]/.test(patched.replace("storePassword 'android'", "")), "no password is written into the file");
});

test("signing: a changed template is reported, never silently built with the debug key", () => {
  const { patchBuildGradle } = require("../mobile/plugins/with-release-signing");
  assert.throws(() => patchBuildGradle("android { buildTypes { release { } } }"), /does not look like the expected template/);
});

test("signing: the plugin is listed in app.json and no key material is in the repo", () => {
  assert.ok(app.plugins.includes("./plugins/with-release-signing"));
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n");
  assert.deepEqual(tracked.filter((f) => /\.(jks|keystore|p12|pfx)$|\.base64$/i.test(f) && !f.endsWith("debug.keystore")), []);
});

// ---------------------------------------------------------------- wallet identity and the web page

test("wallet identity: the app tells the wallet it is Nod at nod.ajkadri.dev, with an icon the page serves", () => {
  const config = read("mobile", "constants", "app-config.ts");
  const uri = config.match(/uri: '(https:\/\/[^']+)'/)[1];
  const icon = config.match(/icon: '([^']+)'/)[1];
  assert.equal(uri, "https://nod.ajkadri.dev");
  assert.match(config, /name: 'Nod'/);
  assert.ok(fs.existsSync(path.join(ROOT, "site", icon)), "the icon is relative to the uri, so the page must serve it");
  assert.match(read("mobile", "components", "app-providers.tsx"), /identity=\{WALLET_IDENTITY\}/);
});

test("site: assetlinks.json names the app and holds only well-formed SHA-256 fingerprints", () => {
  const statements = JSON.parse(read("site", ".well-known", "assetlinks.json"));
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].relation, ["delegate_permission/common.handle_all_urls"]);
  assert.equal(statements[0].target.namespace, "android_app");
  assert.equal(statements[0].target.package_name, app.android.package);
  for (const fingerprint of statements[0].target.sha256_cert_fingerprints) {
    assert.match(fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  }
});

test("site: one page with the wordmark, the line, the steps, a download link and a demo video slot", () => {
  const html = read("site", "index.html");
  assert.match(html, /<h1><span>Your agent asks\.<\/span><span>You nod\.<\/span><\/h1>/);
  assert.match(html, /class="mark"[^>]*>nod<i>\.<\/i>/);
  assert.match(html, /<ol class="steps">/);
  assert.match(html, /href="\/nod\.apk"/, "the APK is served from the VPS, not loaded from GitHub");
  assert.doesNotMatch(html, /raw\/build-artifacts/);
  assert.match(html, /id="video"/);
  assert.match(html, /\/demo\.mp4/);
  // The only script is the inline check for demo.mp4 on the same site. The only other site the page
  // contacts is Google Fonts (a decision of the redesign: it is the one thing loaded from elsewhere).
  // github.com and x.com are links the visitor can follow, not things the page loads.
  const scripts = html.match(/<script[^>]*>/g) || [];
  assert.deepEqual(scripts, ["<script>"], "one inline script, no script files");
  const hosts = new Set((html.match(/https?:\/\/[^"' <)]+/g) || []).map((url) => new URL(url).hostname));
  const allowed = new Set(["nod.ajkadri.dev", "relay.ajkadri.dev", "github.com", "x.com", "fonts.googleapis.com", "fonts.gstatic.com"]);
  for (const host of hosts) assert.ok(allowed.has(host), `unexpected site: ${host}`);
});

// ---------------------------------------------------------------- the installer

test("installer: setup.sh is valid bash, takes a second domain and remembers it", () => {
  const script = path.join(ROOT, "deploy", "vps", "setup.sh");
  execFileSync("bash", ["-n", script]);
  const text = fs.readFileSync(script, "utf8");
  assert.match(text, /usage: sudo bash setup\.sh relay\.example\.com \[site\.example\.com\]/);
  assert.match(text, /SITE_DOMAIN="\$\{2:-\}"/);
  assert.match(text, /\/etc\/nod\/site-domain/);
  assert.match(text, /sslip\.io/);
  assert.match(text, /root \* \$SITE_DIR/);
});

test("installer: the site bundle check sees a stale copy", () => {
  const stale = path.join(ROOT, "site", "stale-test-file.tmp");
  fs.writeFileSync(stale, "x");
  try {
    assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, "scripts", "vps-bundle.js"), "--check"], { stdio: "pipe" }));
  } finally {
    fs.unlinkSync(stale);
  }
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "vps-bundle.js"), "--check"], { stdio: "pipe" });
});

// ---------------------------------------------------------------- publishing the APK

/**
 * Run publish-apk.sh with stand-ins for ssh and curl. The ssh stand-in runs the command it was given
 * on this machine (so the script that would run on the server really runs), and the curl stand-in
 * serves files from a folder instead of GitHub and records the addresses asked for.
 */
function runPublish({ apkBytes = 2_000_000, tamper = false, omit = [], extraEnv = {}, args = ["root@example.org"] } = {}) {
  const os = require("node:os");
  const crypto = require("node:crypto");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nod-publish-"));
  const bin = path.join(dir, "bin");
  const served = path.join(dir, "served");
  const site = path.join(dir, "site");
  for (const d of [bin, served, site]) fs.mkdirSync(d);
  const apk = Buffer.alloc(apkBytes, 7);
  const sum = crypto.createHash("sha256").update(tamper ? Buffer.from("other") : apk).digest("hex");
  const files = {
    "nod.apk": apk,
    SHA256SUMS: `${sum}  nod.apk\n${"0".repeat(64)}  mock-wallet.apk\n`,
    "BUILD.txt": "Built from abc123 by run 9\n",
  };
  for (const [name, body] of Object.entries(files)) if (!omit.includes(name)) fs.writeFileSync(path.join(served, name), body);
  const log = path.join(dir, "calls.log");
  const stub = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  };
  // ssh HOST COMMAND...: log it, then run COMMAND here with the same standard input.
  stub("ssh", `echo "ssh $*" >> "${log}"; shift; "$@"`);
  // curl ... -o FILE URL: log the address, copy the named file from the folder, or fail like curl -f does.
  stub(
    "curl",
    `echo "curl $*" >> "${log}"
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
f="${served}/$(basename "$url")"
[ -f "$f" ] || exit 22
cp "$f" "$out"`,
  );
  stub("gh", `echo "gh $*" >> "${log}"; exit 1`);
  stub("scp", `echo "scp $*" >> "${log}"; exit 1`);
  let status = 0;
  let output = "";
  try {
    output = execFileSync("bash", [path.join(ROOT, "scripts", "publish-apk.sh"), ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NOD_SITE_DIR: site, ...extraEnv },
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    status = error.status;
    output = `${error.stdout}${error.stderr}`;
  }
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  return { status, output, calls, dir, site, sum, apk };
}

test("publish-apk: the server downloads the build from the public repo's build-artifacts branch and swaps it in", () => {
  const { status, calls, site, sum, apk, output } = runPublish();
  assert.equal(status, 0, output);
  for (const file of ["nod.apk", "SHA256SUMS", "BUILD.txt"]) {
    assert.match(calls, new RegExp(`curl .*https://github\\.com/AjKadri/nod-app/raw/build-artifacts/${file.replace(".", "\\.")}`));
  }
  // Nothing is uploaded from the laptop, and the GitHub CLI is not needed.
  assert.doesNotMatch(calls, /^(scp|gh) /m);
  assert.ok(fs.readFileSync(path.join(site, "nod.apk")).equals(apk));
  // The site lists only the file it serves, and no temporary files are left.
  assert.equal(fs.readFileSync(path.join(site, "SHA256SUMS"), "utf8"), `${sum}  nod.apk\n`);
  assert.deepEqual(fs.readdirSync(site).sort(), ["SHA256SUMS", "nod.apk"]);
  assert.match(output, /Built from abc123 by run 9/);
});

test("publish-apk: NOD_REPO changes where the server downloads from", () => {
  const { status, calls } = runPublish({ extraEnv: { NOD_REPO: "someone/fork" } });
  assert.equal(status, 0);
  assert.match(calls, /github\.com\/someone\/fork\/raw\/build-artifacts\/nod\.apk/);
});

test("publish-apk: a download that does not match its checksum is never published", () => {
  const { status, output, site } = runPublish({ tamper: true });
  assert.notEqual(status, 0);
  assert.match(output, /does not match SHA256SUMS/);
  assert.deepEqual(fs.readdirSync(site), []);
});

test("publish-apk: a tiny file, or a build that is not there yet, is never published", () => {
  const tiny = runPublish({ apkBytes: 100 });
  assert.notEqual(tiny.status, 0);
  assert.match(tiny.output, /suspiciously small/);
  assert.deepEqual(fs.readdirSync(tiny.site), []);
  const missing = runPublish({ omit: ["SHA256SUMS"] });
  assert.notEqual(missing.status, 0);
  assert.match(missing.output, /Could not download .*SHA256SUMS.*CI build/);
  assert.deepEqual(fs.readdirSync(missing.site), []);
});

test("publish-apk: an existing nod.apk stays in place when the new download fails", () => {
  const site = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "nod-site-"));
  fs.writeFileSync(path.join(site, "nod.apk"), "old build");
  const result = runPublish({ tamper: true, extraEnv: { NOD_SITE_DIR: site } });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(site, "nod.apk"), "utf8"), "old build");
});

test("publish-apk: needs a server, and refuses odd repo or folder names before connecting", () => {
  const none = runPublish({ args: [], extraEnv: { NOD_SERVER: "" } });
  assert.notEqual(none.status, 0);
  assert.equal(none.calls, "");
  const bad = runPublish({ extraEnv: { NOD_REPO: "a/b; rm -rf /" } });
  assert.notEqual(bad.status, 0);
  assert.match(bad.output, /owner\/name/);
  assert.equal(bad.calls, "");
  const odd = runPublish({ extraEnv: { NOD_SITE_DIR: "/var/www/my site" } });
  assert.notEqual(odd.status, 0);
  assert.equal(odd.calls, "");
});
