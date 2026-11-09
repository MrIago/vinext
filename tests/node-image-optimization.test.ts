import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build, createBuilder } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";
import { loadSharp, type Sharp } from "../packages/vinext/src/server/image-sharp.js";
import { requestNodeServerWithHost } from "./helpers.js";

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

  let origin: Server;
  let originUrl = "";

  beforeAll(async () => {
    const source = await photo(400, 200);
    // A remote image host. It is on loopback, so the apps opt into
    // dangerouslyAllowLocalIP as Next.js' own image tests do.
    origin = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=600" });
      res.end(source);
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
    const nextConfig =
      "export default { images: { dangerouslyAllowLocalIP: true, " +
      'remotePatterns: [{ protocol: "http", hostname: "127.0.0.1", pathname: "/remote/**" }] } };\n';

    const pagesDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-sharp-"));
    dirs.push(pagesDir);
    await linkWorkspaceNodeModules(pagesDir);
    await fs.mkdir(path.join(pagesDir, "pages"));
    await fs.writeFile(
      path.join(pagesDir, "pages", "index.jsx"),
      "export default function Page() {\n  return <p>home</p>;\n}\n",
    );
    await fs.writeFile(path.join(pagesDir, "next.config.mjs"), nextConfig);
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
    await fs.writeFile(path.join(appDir, "next.config.mjs"), nextConfig);
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

    it(`${router} router: caches the variant on disk and revalidates it by ETag`, async () => {
      const url = `${urls[router]}/_next/image?url=%2Fphoto.png&w=256&q=75`;
      const headers = { Accept: "image/webp" };
      const first = await fetch(url, { headers });
      expect(first.headers.get("x-nextjs-cache")).toBe("MISS");
      const body = await first.arrayBuffer();
      const repeat = await fetch(url, { headers });
      expect(repeat.headers.get("x-nextjs-cache")).toBe("HIT");
      expect(repeat.headers.get("Content-Type")).toBe("image/webp");
      expect(repeat.headers.get("ETag")).toBe(first.headers.get("ETag"));
      expect(new Uint8Array(await repeat.arrayBuffer())).toEqual(new Uint8Array(body));
      const port = Number(new URL(url).port);
      const notModified = await requestNodeServerWithHost(
        port,
        new URL(url).pathname + new URL(url).search,
        `127.0.0.1:${port}`,
        { ...headers, "If-None-Match": first.headers.get("ETag")! },
      );
      expect(notModified.status).toBe(304);
      const cacheDir = path.join(router === "app" ? dirs[1] : dirs[0], "dist", "cache", "images");
      expect((await fs.readdir(cacheDir)).length).toBeGreaterThan(0);
    });

    // Ported from Next.js: test/e2e/image-optimizer/util.ts ("should resize
    // absolute url from localhost", "should fail when domain is not defined
    // in next.config.js").
    it(`${router} router: optimizes a remote image images.remotePatterns allows`, async () => {
      const remote = encodeURIComponent(`${originUrl}/remote/photo.png`);
      const res = await fetch(`${urls[router]}/_next/image?url=${remote}&w=64&q=75`, {
        headers: { Accept: "image/webp" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/webp");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
      expect(await metadata(await res.arrayBuffer())).toMatchObject({ format: "webp", width: 64 });

      for (const source of [`${originUrl}/elsewhere/photo.png`, "http://localhost/remote/a.png"]) {
        const denied = await fetch(
          `${urls[router]}/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`,
        );
        expect(denied.status, source).toBe(400);
        await denied.arrayBuffer();
      }
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

// Ported from Next.js: test/e2e/image-optimizer/util.ts (x-nextjs-cache MISS
// then HIT, ETag and 304), test/e2e/image-optimizer/max-disk-size-cache-zero.test.ts
// and test/unit/image-optimizer/lru-disk-eviction.test.ts.
// https://github.com/vercel/next.js/blob/canary/test/e2e/image-optimizer/util.ts
// https://github.com/vercel/next.js/blob/canary/test/unit/image-optimizer/lru-disk-eviction.test.ts
describe("Node image disk cache", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  });

  async function cacheDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-image-cache-"));
    dirs.push(dir);
    return path.join(dir, "cache", "images");
  }

  const request = (search: string, headers: Record<string, string> = {}) =>
    new Request(`http://localhost/_next/image?${search}`, {
      headers: { Accept: "image/webp", ...headers },
    });

  function optimizer(maxAge: number | ((call: number) => number) = 60) {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      optimize: async () => {
        calls++;
        return new Response(`image ${calls}`, {
          headers: {
            "Content-Type": "image/webp",
            "Cache-Control": `public, max-age=${typeof maxAge === "number" ? maxAge : maxAge(calls)}, must-revalidate`,
            "Content-Security-Policy": "script-src 'none'; frame-src 'none'; sandbox;",
            Vary: "Accept",
            "X-Nextjs-Cache": "MISS",
          },
        });
      },
    };
  }

  it("serves a cached variant as a HIT with its ETag, and 304 on a match", async () => {
    const { NodeImageCache } =
      await import("../packages/vinext/src/server/node-image-optimization.js");
    const cache = new NodeImageCache(await cacheDir());
    const source = optimizer();

    const miss = await cache.handle(request("url=%2Fa.png&w=64&q=75"), undefined, source.optimize);
    expect(miss.headers.get("x-nextjs-cache")).toBe("MISS");
    const etag = miss.headers.get("ETag");
    expect(etag).toMatch(/^[\w-]{43}$/);
    expect(await miss.text()).toBe("image 1");

    const hit = await cache.handle(request("url=%2Fa.png&w=64&q=75"), undefined, source.optimize);
    expect(hit.headers.get("x-nextjs-cache")).toBe("HIT");
    expect(hit.headers.get("x-vinext-cache")).toBe("HIT");
    expect(hit.headers.get("ETag")).toBe(etag);
    expect(hit.headers.get("Cache-Control")).toBe("public, max-age=60, must-revalidate");
    expect(hit.headers.get("Content-Security-Policy")).toBe(
      "script-src 'none'; frame-src 'none'; sandbox;",
    );
    expect(await hit.text()).toBe("image 1");
    expect(source.calls).toBe(1);

    const notModified = await cache.handle(
      request("url=%2Fa.png&w=64&q=75", { "If-None-Match": etag! }),
      undefined,
      source.optimize,
    );
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("x-nextjs-cache")).toBeNull();

    // Another width, or a client that accepts another format, is another variant.
    await cache.handle(request("url=%2Fa.png&w=128&q=75"), undefined, source.optimize);
    await cache.handle(
      request("url=%2Fa.png&w=64&q=75", { Accept: "image/png" }),
      undefined,
      source.optimize,
    );
    expect(source.calls).toBe(3);
  });

  it("serves an expired variant STALE and optimizes it again once in the background", async () => {
    const { NodeImageCache } =
      await import("../packages/vinext/src/server/node-image-optimization.js");
    const cache = new NodeImageCache(await cacheDir());
    // The first rendition expires at once; its replacement stays fresh.
    const source = optimizer((call) => (call === 1 ? 0 : 60));
    const config = { minimumCacheTTL: 0 };

    await cache.handle(request("url=%2Fb.png&w=64&q=75"), config, source.optimize);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [first, second] = await Promise.all([
      cache.handle(request("url=%2Fb.png&w=64&q=75"), config, source.optimize),
      cache.handle(request("url=%2Fb.png&w=64&q=75"), config, source.optimize),
    ]);
    expect(first.headers.get("x-nextjs-cache")).toBe("STALE");
    expect(second.headers.get("x-nextjs-cache")).toBe("STALE");
    expect(await first.text()).toBe("image 1");
    await expect.poll(() => source.calls).toBe(2);
    await expect
      .poll(async () =>
        (await cache.handle(request("url=%2Fb.png&w=64&q=75"), config, source.optimize)).text(),
      )
      .toBe("image 2");
  });

  it("keeps nothing under images.maximumDiskCacheSize: 0", async () => {
    const { NodeImageCache } =
      await import("../packages/vinext/src/server/node-image-optimization.js");
    const dir = await cacheDir();
    const cache = new NodeImageCache(dir, 0);
    const source = optimizer();
    for (let i = 0; i < 2; i++) {
      const res = await cache.handle(request("url=%2Fc.png&w=64&q=75"), undefined, source.optimize);
      expect(res.headers.get("x-nextjs-cache")).toBe("MISS");
      expect(res.headers.get("ETag")).toBeTruthy();
    }
    expect(source.calls).toBe(2);
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it("evicts the least recently used variants past images.maximumDiskCacheSize", async () => {
    const { NodeImageCache } =
      await import("../packages/vinext/src/server/node-image-optimization.js");
    const dir = await cacheDir();
    // Each body is 7 bytes ("image N"): room for two.
    const cache = new NodeImageCache(dir, 15);
    const source = optimizer();
    for (const name of ["d", "e"]) {
      await cache.handle(request(`url=%2F${name}.png&w=64&q=75`), undefined, source.optimize);
    }
    // Using d makes e the least recently used one.
    await cache.handle(request("url=%2Fd.png&w=64&q=75"), undefined, source.optimize);
    await cache.handle(request("url=%2Ff.png&w=64&q=75"), undefined, source.optimize);
    expect(await fs.readdir(dir)).toHaveLength(2);
    const d = await cache.handle(request("url=%2Fd.png&w=64&q=75"), undefined, source.optimize);
    expect(d.headers.get("x-nextjs-cache")).toBe("HIT");
    const e = await cache.handle(request("url=%2Fe.png&w=64&q=75"), undefined, source.optimize);
    expect(e.headers.get("x-nextjs-cache")).toBe("MISS");
  });
});
