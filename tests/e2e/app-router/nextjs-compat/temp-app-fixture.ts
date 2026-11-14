/**
 * A throwaway App Router app for a spec that ports a Next.js fixture whole:
 * its files are written to a temp dir, then built and served in production,
 * or served by the dev server.
 */
import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ViteDevServer } from "vite";

export type TempAppFiles = Record<string, string>;

export type TempApp = {
  baseUrl: string;
  close(): Promise<void>;
};

async function linkFixtureNodeModules(fixtureRoot: string): Promise<void> {
  const sourceNodeModules = path.resolve(process.cwd(), "tests/fixtures/app-basic/node_modules");
  const targetNodeModules = path.join(fixtureRoot, "node_modules");
  await fs.mkdir(targetNodeModules, { recursive: true });
  for (const entry of await fs.readdir(sourceNodeModules, { withFileTypes: true })) {
    if (entry.name === ".vite" || entry.name === ".vite-temp") continue;
    await fs.symlink(
      path.join(sourceNodeModules, entry.name),
      path.join(targetNodeModules, entry.name),
      entry.isDirectory() ? "junction" : "file",
    );
  }
}

/**
 * Copy a fixture from `tests/fixtures` to a temp dir, with a package.json, a
 * vite.config.ts using vinext's source, and `files` over it.
 */
export async function writeTempApp(fixture: string, files: TempAppFiles = {}): Promise<string> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), `vinext-${fixture}-`));
  await fs.cp(path.resolve(process.cwd(), "tests/fixtures", fixture), fixtureRoot, {
    recursive: true,
  });
  await linkFixtureNodeModules(fixtureRoot);
  const vinextSource = path.resolve(process.cwd(), "packages/vinext/src/index.ts");
  const allFiles: TempAppFiles = {
    "package.json": `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
    "vite.config.ts": `import { defineConfig } from "vite";
import vinext from ${JSON.stringify(pathToFileURL(vinextSource).href)};

export default defineConfig({ plugins: [vinext({ appDir: import.meta.dirname })] });
`,
    ...files,
  };
  for (const [relativePath, content] of Object.entries(allFiles)) {
    const filePath = path.join(fixtureRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  return fixtureRoot;
}

export async function removeTempApp(fixtureRoot: string): Promise<void> {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}

/** Build the app and prerender it, as `vinext build` does. Rejects with the prerender's error. */
export async function buildTempApp(fixtureRoot: string): Promise<void> {
  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: path.join(fixtureRoot, "vite.config.ts"),
    logLevel: "silent",
  });
  await builder.buildApp();
  const { runPrerender } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/build/run-prerender.js")).href
  );
  await runPrerender({ root: fixtureRoot });
}

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

/** Serve a built app with the production server. */
export async function serveTempApp(fixtureRoot: string): Promise<TempApp> {
  const { startProdServer } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/server/prod-server.js")).href
  );
  const started = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: path.join(fixtureRoot, "dist"),
    noCompression: true,
  });
  return {
    baseUrl: `http://127.0.0.1:${started.port}`,
    close: () => closeServer(started.server),
  };
}

/** Serve the app with the dev server. */
export async function serveTempAppInDev(fixtureRoot: string): Promise<TempApp> {
  const { createServer } = await import("vite");
  const server: ViteDevServer = await createServer({
    root: fixtureRoot,
    configFile: path.join(fixtureRoot, "vite.config.ts"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local[0]?.replace(/\/$/, "");
  if (!baseUrl) {
    await server.close();
    throw new Error("Vite dev server did not expose a local URL");
  }
  return { baseUrl, close: () => server.close() };
}
