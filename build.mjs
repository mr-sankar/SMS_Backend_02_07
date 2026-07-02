import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm, cp } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.js")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    alias: {
      "@workspace/db": path.resolve(artifactDir, "src/db/index.js"),
      "@workspace/api-zod": path.resolve(artifactDir, "src/api-zod/index.js"),
    },
    external: [
      "@electric-sql/pglite",
      "@electric-sql/pglite-utils",
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      'googleapis',
    ],
    sourcemap: "linked",
    plugins: [
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
  
  // Copy PDFKit's standard font data files (AFM) into dist/data/
  // PDFKit resolves them via __dirname which points to dist/ after bundling
  const pdfkitDataSrc = path.resolve(artifactDir, "node_modules/pdfkit/js/data");
  const pdfkitDataDest = path.resolve(distDir, "data");
  await cp(pdfkitDataSrc, pdfkitDataDest, { recursive: true });
  console.log("Copied PDFKit font data to dist/data/");

}



buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
