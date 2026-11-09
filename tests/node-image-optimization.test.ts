import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import type { Server } from "node:http";
import { build, createBuilder } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";
import { loadSharp, type Sharp } from "../packages/vinext/src/server/image-sharp.js";

// sharp is no dependency of vinext; the workspace has it through other
// packages, in pnpm's hoisted virtual store.
const WORKSPACE_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");
const SHARP_ROOT = path.join(WORKSPACE_NODE_MODULES, ".pnpm");

/** The sharp calls these tests make beyond what vinext's own type covers. */
type TestSharp = (input: unknown) => {
  metadata(): Promise<{ format: string; width: number; height: number }>;
  png(): { toBuffer(): Promise<Buffer> };
};

async function workspaceSharp(): Promise<TestSharp> {
  const sharp: Sharp | null = await loadSharp([SHARP_ROOT]);
  if (!sharp) throw new Error("expected the workspace to provide sharp");
  return sharp as unknown as TestSharp;
}

async function photo(width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  const sharp = await workspaceSharp();
  const png = await sharp({
    create: { width, height, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

async function metadata(bytes: ArrayBuffer) {
  return (await workspaceSharp())(new Uint8Array(bytes)).metadata();
}

/** Give the built server the app's `sharp`, as an installed app has it. */
async function installSharp(outDir: string): Promise<void> {
  await fs.mkdir(path.join(outDir, "node_modules"), { recursive: true });
  await fs.symlink(
    await fs.realpath(path.join(SHARP_ROOT, "node_modules", "sharp")),
    path.join(outDir, "node_modules", "sharp"),
    "dir",
  );
}

async function startServer(outDir: string): Promise<{ server: Server; baseUrl: string }> {
  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const started = await startProdServer({ port: 0, host: "127.0.0.1", outDir, silent: true });
  const server = "server" in started ? started.server : started;
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("expected a port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function linkWorkspaceNodeModules(fixtureDir: string): Promise<void> {
  await fs.symlink(WORKSPACE_NODE_MODULES, path.join(fixtureDir, "node_modules"), "dir");
}

// Ported from Next.js: test/unit/image-optimizer/transform.test.ts
// https://github.com/vercel/next.js/blob/canary/test/unit/image-optimizer/transform.test.ts
describe("sharp image optimizer", () => {
  it("resizes without enlarging and encodes the requested format", async () => {
    const { createSharpImageOptimizer } =
      await import("../packages/vinext/src/server/image-sharp.js");
    const sharp = await loadSharp([SHARP_ROOT]);
    const optimizer = createSharpImageOptimizer(sharp!);
    const source = await photo(400, 200);

    const webp = await optimizer.transformImage(new Response(source).body!, {
      width: 64,
      format: "image/webp",
      quality: 75,
    });
    expect(webp.headers.get("Content-Type")).toBe("image/webp");
    expect(await metadata(await webp.arrayBuffer())).toMatchObject({
      format: "webp",
      width: 64,
      height: 32,
    });

    const avif = await optimizer.transformImage(new Response(source).body!, {
      width: 3840,
      format: "image/avif",
      quality: 75,
    });
    expect(avif.headers.get("Content-Type")).toBe("image/avif");
    expect(await metadata(await avif.arrayBuffer())).toMatchObject({ width: 400, height: 200 });
  });

  // pnpm puts its virtual store on NODE_PATH, which this test runs under.
  it("resolves sharp from the application's node_modules only", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-no-sharp-"));
    try {
      expect(await loadSharp([empty])).toBeNull();
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});

// Ported from Next.js: test/e2e/image-optimizer/util.ts ("should resize
// relative url and webp Firefox accept header", "should resize relative url
// with invalid accept header as png", "should maintain png format for old
// Safari").
// https://github.com/vercel/next.js/blob/canary/test/e2e/image-optimizer/util.ts
describe("Node production server optimizes images with the app's sharp", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  const urls: Record<"app" | "pages", string> = { app: "", pages: "" };

  beforeAll(async () => {
    const source = await photo(400, 200);

    const pagesDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-sharp-"));
    dirs.push(pagesDir);
    await linkWorkspaceNodeModules(pagesDir);
    await fs.mkdir(path.join(pagesDir, "pages"));
    await fs.writeFile(
      path.join(pagesDir, "pages", "index.jsx"),
      "export default function Page() {\n  return <p>home</p>;\n}\n",
    );
    await fs.mkdir(path.join(pagesDir, "public"));
    await fs.writeFile(path.join(pagesDir, "public", "photo.png"), source);
    const pagesOut = path.join(pagesDir, "dist");
    for (const buildOptions of [
      {
        outDir: path.join(pagesOut, "server"),
        ssr: "virtual:vinext-server-entry",
        rolldownOptions: { output: { entryFileNames: "entry.js" } },
      },
      {
        outDir: path.join(pagesOut, "client"),
        manifest: true,
        ssrManifest: true,
        rolldownOptions: { input: "virtual:vinext-client-entry" },
      },
    ]) {
      await build({
        root: pagesDir,
        configFile: false,
        plugins: [vinext({ disableAppRouter: true })],
        logLevel: "silent",
        build: buildOptions,
      });
    }
    await installSharp(pagesOut);
    const pages = await startServer(pagesOut);
    servers.push(pages.server);
    urls.pages = pages.baseUrl;

    const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-app-sharp-"));
    dirs.push(appDir);
    await linkWorkspaceNodeModules(appDir);
    await fs.writeFile(path.join(appDir, "package.json"), '{ "type": "module" }\n');
    await fs.mkdir(path.join(appDir, "app"));
    await fs.writeFile(
      path.join(appDir, "app", "layout.tsx"),
      "export default function Layout({ children }: { children: React.ReactNode }) {\n" +
        "  return <html><body>{children}</body></html>;\n}\n",
    );
    await fs.writeFile(
      path.join(appDir, "app", "page.tsx"),
      "export default function Page() {\n  return <p>home</p>;\n}\n",
    );
    await fs.mkdir(path.join(appDir, "public"));
    await fs.writeFile(path.join(appDir, "public", "photo.png"), source);
    const appOut = path.join(appDir, "dist");
    const builder = await createBuilder({
      root: appDir,
      configFile: false,
      plugins: [vinext({ appDir })],
      logLevel: "silent",
    });
    await builder.buildApp();
    await installSharp(appOut);
    const app = await startServer(appOut);
    servers.push(app.server);
    urls.app = app.baseUrl;
  }, 180000);

  afterAll(async () => {
    for (const server of servers)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  });

  for (const router of ["app", "pages"] as const) {
    it(`${router} router: resizes a public PNG to the requested width as WebP`, async () => {
      const res = await fetch(`${urls[router]}/_next/image?url=%2Fphoto.png&w=64&q=75`, {
        headers: { Accept: "image/avif,image/webp,*/*" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/webp");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
      expect(res.headers.get("Vary")).toBe("Accept");
      expect(await metadata(await res.arrayBuffer())).toMatchObject({
        format: "webp",
        width: 64,
        height: 32,
      });
    });

    it(`${router} router: keeps a PNG for a client that accepts no WebP`, async () => {
      const res = await fetch(`${urls[router]}/_next/image?url=%2Fphoto.png&w=128&q=75`, {
        headers: { Accept: "image/png,*/*" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(await metadata(await res.arrayBuffer())).toMatchObject({ format: "png", width: 128 });
    });
  }
});
