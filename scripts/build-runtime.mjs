import { build } from "esbuild";

await build({
  entryPoints: ["packages/cli/src/bin.ts"],
  outfile: "distribution/runtime/rockspec.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "bundle",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  sourcemap: false,
  legalComments: "none",
});
