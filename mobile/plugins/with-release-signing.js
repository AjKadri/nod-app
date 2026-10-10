// Signs the release APK with your own key when one is provided, and with the debug key otherwise
// (so a build without secrets still works, and says so). The key never lives in the repo: CI
// writes it to a temporary file and passes these environment variables.
//
//   NOD_KEYSTORE_PATH       full path to the .jks / .p12 file
//   NOD_KEYSTORE_PASSWORD   store password (the key uses the same password: PKCS12)
//   NOD_KEY_ALIAS           the key's alias
const RELEASE_SIGNING = `    signingConfigs {
        release {
            def nodKeystore = System.getenv('NOD_KEYSTORE_PATH')
            if (nodKeystore) {
                storeFile file(nodKeystore)
                storePassword System.getenv('NOD_KEYSTORE_PASSWORD')
                keyAlias System.getenv('NOD_KEY_ALIAS')
                keyPassword System.getenv('NOD_KEYSTORE_PASSWORD')
            }
        }
`

const RELEASE_USES = `signingConfig System.getenv('NOD_KEYSTORE_PATH') ? signingConfigs.release : signingConfigs.debug`

/** Returns the build.gradle text with the release signing added. Throws if the template changed shape. */
function patchBuildGradle(text) {
  if (text.includes('NOD_KEYSTORE_PATH')) return text // already patched
  const signing = /(\n)    signingConfigs \{\n/
  const release = /(buildTypes \{[\s\S]*?release \{\n(?:\s*\/\/[^\n]*\n)*\s*)signingConfig signingConfigs\.debug/
  if (!signing.test(text) || !release.test(text)) {
    throw new Error(
      'with-release-signing: android/app/build.gradle does not look like the expected template (signingConfigs or the release build type was not found). Update mobile/plugins/with-release-signing.js.',
    )
  }
  return text.replace(signing, `$1${RELEASE_SIGNING}`).replace(release, `$1${RELEASE_USES}`)
}

const withReleaseSigning = (config) => {
  // Loaded here, not at the top, so the laptop-side tests can use patchBuildGradle without the app's packages.
  const { withAppBuildGradle } = require('@expo/config-plugins')
  return withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = patchBuildGradle(mod.modResults.contents)
    return mod
  })
}

module.exports = withReleaseSigning
module.exports.patchBuildGradle = patchBuildGradle
