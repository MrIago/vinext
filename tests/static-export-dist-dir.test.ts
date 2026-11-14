import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { resolveNextConfig } from "../packages/vinext/src/config/next-config.js";
import {
  copyStaticExportToDistDir,
  runPrerender,
} from "../packages/vinext/src/build/run-prerender.js";
import { createIsolatedFixture, testCacheDir } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/static-export");

function listFiles(dir: string, prefix = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? listFiles(path.join(dir, entry.name), relativePath)
      : [relativePath];
  });
}

// Ported from Next.js: test/e2e/app-dir-export/test/config.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir-export/test/config.test.ts
// With `output: "export"`, a custom `distDir` names the export destination,
// while build artifacts stay in the intermediate build directory
// (vercel/next.js#99507, packages/next/src/export/utils.ts).
describe("static export with a custom distDir", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function buildExport(distDir: string): Promise<string> {
    const root = await createIsolatedFixture(FIXTURE_DIR, "vinext-export-dist-dir-");
    cleanup.push(root);
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      `export default ${JSON.stringify({ output: "export", trailingSlash: true, distDir })};\n`,
    );
    const builder = await createBuilder({
      root,
      cacheDir: testCacheDir(root),
      configFile: false,
      plugins: [vinext({ appDir: root })],
      logLevel: "silent",
    });
    await builder.buildApp();
    // `vinext build` runs the export after the Vite build; so does deploy.
    await runPrerender({ root, concurrency: 1 });
    return root;
  }

  it("emits the exported site to a relative distDir", async () => {
    const root = await buildExport("output");
    const exportDir = path.join(root, "output");

    const files = listFiles(exportDir);
    expect(files).toContain("index.html");
    expect(files).toContain("about/index.html");
    expect(files).toContain("about/index.txt");
    expect(files.some((file) => file.startsWith("_next/static/"))).toBe(true);
    // Build metadata is not part of the exported site.
    expect(files.some((file) => file.startsWith(".vite/"))).toBe(false);
    expect(files).not.toContain("vinext-client-entry-manifest.json");

    // Build artifacts stay in the intermediate build directory.
    expect(fs.existsSync(path.join(root, "dist", "server"))).toBe(true);
    expect(fs.existsSync(path.join(exportDir, "server"))).toBe(false);
  }, 120_000);

  it("emits the exported site to an absolute distDir", async () => {
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-export-abs-"));
    cleanup.push(exportDir);
    fs.writeFileSync(path.join(exportDir, "stale.html"), "stale");

    await buildExport(exportDir);

    const files = listFiles(exportDir);
    expect(files).toContain("index.html");
    expect(files).toContain("about/index.html");
    // The destination is replaced, like Next.js clearing its export outDir.
    expect(files).not.toContain("stale.html");
  }, 120_000);

  it("keeps the configured distDir in the resolved config", async () => {
    expect((await resolveNextConfig({ output: "export", distDir: "custom-out" })).distDir).toBe(
      "custom-out",
    );
    expect((await resolveNextConfig({ output: "export" })).distDir).toBe(".next");
  });

  it("refuses a distDir that would replace the project or its build output", () => {
    const root = path.resolve("/project");
    const options = {
      root,
      exportDir: path.join(root, "dist", "client"),
      buildOutDir: path.join(root, "dist"),
    };
    for (const distDir of [".", "dist", "dist/client", "dist/client/site"]) {
      expect(() => copyStaticExportToDistDir({ ...options, distDir })).toThrow(
        /cannot be used as the static export destination/,
      );
    }
  });

  // Next.js copies all of public/ into the export, build metadata names
  // included; only the files the build generated are left out
  // (cloudflare/vinext#4697 keeps public/.vite/ the same way).
  it("keeps public files at build metadata paths in the copied export", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-export-public-"));
    cleanup.push(root);
    const exportDir = path.join(root, "dist", "client");
    const publicDir = path.join(root, "public");
    for (const [dir, file] of [
      [exportDir, ".vite/manifest.json"],
      [exportDir, ".vite/kept.txt"],
      [exportDir, ".assetsignore"],
      [exportDir, "index.html"],
      [publicDir, ".vite/kept.txt"],
    ] as const) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), file);
    }

    copyStaticExportToDistDir({
      root,
      exportDir,
      buildOutDir: path.join(root, "dist"),
      distDir: "out",
      publicDir,
    });

    expect(listFiles(path.join(root, "out")).sort()).toEqual([".vite/kept.txt", "index.html"]);
  });

  it("drops an emptied .vite directory from the copied export", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-export-novite-"));
    cleanup.push(root);
    const exportDir = path.join(root, "dist", "client");
    fs.mkdirSync(path.join(exportDir, ".vite"), { recursive: true });
    fs.writeFileSync(path.join(exportDir, ".vite", "manifest.json"), "{}");
    fs.writeFileSync(path.join(exportDir, "index.html"), "");

    copyStaticExportToDistDir({
      root,
      exportDir,
      buildOutDir: path.join(root, "dist"),
      distDir: "out",
      publicDir: null,
    });

    expect(fs.readdirSync(path.join(root, "out"))).toEqual(["index.html"]);
  });

  // Reported in cloudflare/vinext#3743: with the export source inside the
  // destination, clearing the destination deleted the source before the copy.
  it("refuses a distDir that contains the export source, leaving the source intact", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-export-nested-"));
    cleanup.push(root);
    const exportDir = path.join(root, "site", "assets");
    fs.mkdirSync(exportDir, { recursive: true });
    fs.writeFileSync(path.join(exportDir, "index.html"), "<p>export</p>");

    expect(() =>
      copyStaticExportToDistDir({
        root,
        exportDir,
        buildOutDir: path.join(root, "build"),
        distDir: "site",
      }),
    ).toThrow(/cannot be used as the static export destination/);
    expect(fs.readFileSync(path.join(exportDir, "index.html"), "utf8")).toBe("<p>export</p>");
  });
});
