const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
// Firebase JS SDK ships .cjs files and needs the classic resolver in React Native.
config.resolver.sourceExts.push('cjs');
config.resolver.unstable_enablePackageExports = false;
module.exports = config;
