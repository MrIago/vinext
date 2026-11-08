/**
 * With both routers, the client dep optimizer must crawl pages/ as well as
 * app/. Otherwise a dependency that only Pages Router pages (or `_app`) import
 * is discovered while serving the first page, which re-runs the optimizer and
 * reloads the browser. https://github.com/cloudflare/vinext/issues/4592
 */
import { describe, it, expect } from "vite-plus/test";
import { createLogger, createServer, type ViteDevServer } from "vite";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";

async function setupHybridProject(): Promise<string> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-optdeps-hybrid-"));
  const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  const tmpNodeModules = path.join(tmpDir, "node_modules");
  await fsp.mkdir(tmpNodeModules, { recursive: true });
  for (const entry of await fsp.readdir(rootNodeModules, { withFileTypes: true })) {
    await fsp.symlink(
      path.join(rootNodeModules, entry.name),
      path.join(tmpNodeModules, entry.name),
      entry.isDirectory() ? "junction" : "file",
    );
  }
  const depDir = path.join(tmpNodeModules, "pages-only-dep");
  await fsp.mkdir(depDir, { recursive: true });
  await fsp.writeFile(
    path.join(depDir, "package.json"),
    JSON.stringify({ name: "pages-only-dep", version: "1.0.0", type: "module", main: "index.js" }),
  );
  await fsp.writeFile(path.join(depDir, "index.js"), `export const value = "pages-only";`);

  await fsp.mkdir(path.join(tmpDir, "app"), { recursive: true });
  await fsp.writeFile(
    path.join(tmpDir, "app/layout.tsx"),
    `export default function L({ children }: { children: React.ReactNode }) {
      return (<html><body>{children}</body></html>);
    }`,
  );
  await fsp.writeFile(
    path.join(tmpDir, "app/page.tsx"),
    `export default function P() { return <main>app</main>; }`,
  );
  await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
  await fsp.writeFile(
    path.join(tmpDir, "pages/legacy.tsx"),
    `import { value } from "pages-only-dep";
export default function Legacy() { return <main>{value}</main>; }`,
  );
  await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);
  return tmpDir;
}

describe("optimizeDeps entries with both app/ and pages/", () => {
  it("discovers dependencies only Pages Router pages import at client startup", async () => {
    const tmpDir = await setupHybridProject();
    let server: ViteDevServer | null = null;
    try {
      server = await createServer({
        root: tmpDir,
        configFile: false,
        cacheDir: path.join(tmpDir, ".vite"),
        customLogger: createLogger("silent"),
        plugins: [vinext({ appDir: tmpDir })],
        server: { host: "127.0.0.1", port: 0 },
      });
      await server.listen();
      const optimizer = server.environments.client.depsOptimizer;
      expect(optimizer).toBeDefined();
      await optimizer!.scanProcessing;
      const known = [
        ...Object.keys(optimizer!.metadata.optimized),
        ...Object.keys(optimizer!.metadata.discovered),
      ];
      expect(known).toContain("pages-only-dep");
    } finally {
      await server?.close();
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});
