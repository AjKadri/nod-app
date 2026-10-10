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

test("site: one page with the wordmark, the line, three steps, a download link and a demo video slot", () => {
  const html = read("site", "index.html");
  assert.match(html, /Your agent asks\. You nod\./);
  assert.match(html, /class="wordmark"[^>]*>nod<span>\.<\/span>/);
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.match(html, /href="\/nod\.apk"/, "the APK is served from the VPS, not from the private repo");
  assert.doesNotMatch(html, /raw\/build-artifacts/);
  assert.match(html, /id="demo"/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.doesNotMatch(html, /<script|https?:\/\/[^"' ]*(fonts|cdn)\./i, "nothing is loaded from other sites");
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

/** Run publish-apk.sh with stand-ins for gh, scp and ssh that record what they were asked to do. */
function runPublish({ apkBytes = 2_000_000, tamper = false, extraEnv = {} } = {}) {
  const os = require("node:os");
  const crypto = require("node:crypto");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nod-publish-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const apk = Buffer.alloc(apkBytes, 7);
  const sum = crypto.createHash("sha256").update(tamper ? Buffer.from("other") : apk).digest("hex");
  fs.writeFileSync(path.join(dir, "nod.apk"), apk);
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), `${sum}  nod.apk\n${"0".repeat(64)}  mock-wallet.apk\n`);
  fs.writeFileSync(path.join(dir, "BUILD.txt"), "Built from abc123 by run 9\n");
  const log = path.join(dir, "calls.log");
  const stub = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  };
  stub("gh", `echo "gh $*" >> "${log}"
case "$1" in
  auth) exit 0 ;;
  repo) echo "me/private-repo" ;;
  api) f="\${@: -1}"; f="\${f#*contents/}"; f="\${f%%\\?*}"; cat "${dir}/$f" ;;
esac`);
  stub("scp", `echo "scp $*" >> "${log}"; for last; do :; done; cp "\${@: -2:1}" "${dir}/uploaded-$(basename "\${@: -1}")"`);
  stub("ssh", `echo "ssh $*" >> "${log}"`);
  let status = 0;
  let output = "";
  try {
    output = execFileSync("bash", [path.join(ROOT, "scripts", "publish-apk.sh"), "root@example.org"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    status = error.status;
    output = `${error.stdout}${error.stderr}`;
  }
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  return { status, output, calls, dir, sum };
}

test("publish-apk: downloads from the private repo's build-artifacts branch and puts it on the server in one swap", () => {
  const { status, calls, dir, sum } = runPublish();
  assert.equal(status, 0);
  assert.match(calls, /gh api .*repos\/me\/private-repo\/contents\/nod\.apk\?ref=build-artifacts/);
  assert.match(calls, /scp .*\/nod\.apk root@example\.org:\/var\/www\/nod\/\.nod\.apk\.new/);
  assert.match(calls, /ssh root@example\.org .*mv -f \.nod\.apk\.new nod\.apk/);
  // The site lists only the file it serves.
  assert.equal(fs.readFileSync(path.join(dir, "uploaded-.SHA256SUMS.new"), "utf8"), `${sum}  nod.apk\n`);
});

test("publish-apk: a download that does not match its checksum is never uploaded", () => {
  const { status, output, calls } = runPublish({ tamper: true });
  assert.notEqual(status, 0);
  assert.match(output, /does not match SHA256SUMS/);
  assert.doesNotMatch(calls, /scp|ssh/);
});

test("publish-apk: a tiny file is never uploaded, and the server can be named by environment", () => {
  const tiny = runPublish({ apkBytes: 100 });
  assert.notEqual(tiny.status, 0);
  assert.doesNotMatch(tiny.calls, /scp/);
  assert.throws(() => execFileSync("bash", [path.join(ROOT, "scripts", "publish-apk.sh")], { env: { ...process.env, NOD_SERVER: "" }, stdio: "pipe" }));
});
