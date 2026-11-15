// Bundles the API (and the @minimi/core workspace package, which ships as
// TypeScript source) into a single ESM file. Third-party packages stay external.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, "..", "src", "main.ts")],
  outfile: join(here, "..", "dist", "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  plugins: [
    {
      name: "externalize-third-party",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          // Entry points and absolute paths (e.g. "C:\..." on Windows) are not packages.
          if (args.kind === "entry-point" || isAbsolute(args.path)) return undefined;
          if (args.path.startsWith("@minimi/")) return undefined; // bundle workspace code
          return { path: args.path, external: true };
        });
      },
    },
  ],
});
