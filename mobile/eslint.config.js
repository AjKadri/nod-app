// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config')
const expoConfig = require('eslint-config-expo/flat')

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    // app.config.js runs in Node when the app is built, where __dirname exists.
    files: ['app.config.js'],
    languageOptions: { globals: { __dirname: 'readonly' } },
  },
])
