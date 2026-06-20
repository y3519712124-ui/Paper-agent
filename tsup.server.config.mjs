export default {
  entry: ["server/index.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node22",
  outDir: "server-dist",
  dts: false,
  noExternal: ["yaml"],
  outExtension() {
    return { js: ".cjs" };
  },
};
