// Module hooks for tests/native-render.test.ts: React Native and Paseo's plugin client resolve to the strict native
// stand-ins in this folder, so client code renders as the phone app renders it, in node.
const map = {
  "react-native": "./react-native.mjs",
  "@getpaseo/plugin/client/ui": "./plugin-ui.mjs",
  "@getpaseo/plugin/client": "./plugin-client.mjs",
};
export async function resolve(specifier, context, next) {
  if (map[specifier]) return { url: new URL(map[specifier], import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
