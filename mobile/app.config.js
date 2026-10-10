// Adds Firebase to the Android build only when google-services.json is present, so a build
// without push set up still works. Everything else comes from app.json. See docs/hosting.md.
const fs = require('fs')
const path = require('path')

module.exports = ({ config }) => {
  const hasFirebase = fs.existsSync(path.join(__dirname, 'google-services.json'))
  return {
    ...config,
    android: {
      ...config.android,
      // Each CI build gets a higher number, so a new APK installs over the old one.
      versionCode: Number(process.env.NOD_VERSION_CODE) || 1,
      ...(hasFirebase ? { googleServicesFile: './google-services.json' } : {}),
    },
  }
}
