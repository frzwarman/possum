const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
// Takar's unit and count maths (src/domain) and the phone's own logic (src/stok) live in the web app's tree, where
// its tests and type-check cover them. The phone bundles those same files, so the two apps cannot drift apart.
config.watchFolders = [path.resolve(__dirname, '../src/domain'), path.resolve(__dirname, '../src/stok')];

module.exports = config;
