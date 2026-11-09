import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

async function writeFile(file: string, source: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, source, "utf8");
}

async function findRscEntry(rscOutDir: string): Promise<string> {
  const entries = await fsp.readdir(rscOutDir);
  const entry = entries.find((file) => /^index\.m?js$/.test(file));
  if (!entry) {
    throw new Error(`No RSC entry found in ${rscOutDir}. Contents: ${entries.join(", ")}`);
  }
  return path.join(rscOutDir, entry);
}

describe("inline CSS production build", () => {
  it("injects the inline CSS manifest with custom App Router output directories", async () => {
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-inline-css-build-"));
    const outRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-inline-css-build-out-"));
    try {
      await fsp.symlink(ROOT_NODE_MODULES, path.join(fixtureRoot, "node_modules"), "junction");
      await writeFile(
        path.join(fixtureRoot, "package.json"),
        `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
      );
      await writeFile(
        path.join(fixtureRoot, "app", "global.css"),
        ".inline-css-build-marker { color: rgb(1, 2, 3); }\n",
      );
      await writeFile(
        path.join(fixtureRoot, "app", "layout.tsx"),
        `import "./global.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      );
      await writeFile(
        path.join(fixtureRoot, "app", "page.tsx"),
        `export default function Page() {
  return <p className="inline-css-build-marker">home</p>;
}
`,
      );

      const rscOutDir = path.join(outRoot, "custom-rsc");
      const ssrOutDir = path.join(outRoot, "custom-ssr");
      const clientOutDir = path.join(outRoot, "custom-client");
      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        plugins: [
          vinext({
            appDir: fixtureRoot,
            rscOutDir,
            ssrOutDir,
            clientOutDir,
            nextConfig: {
              experimental: {
                inlineCss: true,
              },
            },
          }),
        ],
        logLevel: "silent",
      });

      await builder.buildApp();

      const rscEntry = await findRscEntry(rscOutDir);
      const code = await fsp.readFile(rscEntry, "utf8");

      expect(code).toContain("globalThis.__VINEXT_INLINE_CSS__");
      expect(code).toContain("_next/static");
      // The manifest is read from the client output directory, so the marker
      // CSS is only inlined when clientOutDir is honoured.
      expect(code).toContain("inline-css-build-marker");
    } finally {
      await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(outRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);
  // Ported from Next.js: test/e2e/app-dir/app-inline-css/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-inline-css/index.test.ts
  // With inlineCss, Next.js inlines every stylesheet, the next/font CSS
  // included. The extracted next/font/local stylesheet is linked from the
  // head by the font collector, outside React's stylesheet resources, so it
  // must be inlined as well instead of left as a <link>.
  it("inlines the extracted next/font/local stylesheet", async () => {
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-inline-css-font-"));
    let server: import("node:http").Server | undefined;
    try {
      await fsp.symlink(ROOT_NODE_MODULES, path.join(fixtureRoot, "node_modules"), "junction");
      await writeFile(
        path.join(fixtureRoot, "package.json"),
        `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
      );
      await fsp.mkdir(path.join(fixtureRoot, "app"), { recursive: true });
      await fsp.copyFile(
        path.resolve(
          import.meta.dirname,
          "fixtures/app-basic/app/script-nonce/with-next-font/font.woff2",
        ),
        path.join(fixtureRoot, "app", "font.woff2"),
      );
      await writeFile(path.join(fixtureRoot, "app", "global.css"), "p { color: yellow; }\n");
      await writeFile(
        path.join(fixtureRoot, "app", "font.ts"),
        `import localFont from "next/font/local";

export const font = localFont({ src: "./font.woff2", variable: "--font-1" });
`,
      );
      await writeFile(
        path.join(fixtureRoot, "app", "layout.tsx"),
        `import { font } from "./font";
import "./global.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html className={font.variable}><body>{children}</body></html>;
}
`,
      );
      await writeFile(
        path.join(fixtureRoot, "app", "page.tsx"),
        `export default function Page() {
  return <p id="home">home</p>;
}
`,
      );

      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        plugins: [
          vinext({
            appDir: fixtureRoot,
            nextConfig: { experimental: { inlineCss: true } },
          }),
        ],
        logLevel: "silent",
        build: { assetsInlineLimit: 0 },
      });
      await builder.buildApp();

      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      ({ server } = await startProdServer({
        port: 0,
        outDir: path.join(fixtureRoot, "dist"),
        noCompression: true,
      }));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const html = await (await fetch(`http://localhost:${port}/`)).text();

      const inlineStyles = [
        ...html.matchAll(/<style data-vinext-inline-css[^>]*>([\s\S]*?)<\/style>/g),
      ].map((m) => m[1]);
      expect(inlineStyles.join("\n")).toContain("@font-face");
      expect(inlineStyles.join("\n")).toContain("color");
      expect(html).not.toMatch(
        /<link rel="stylesheet"[^>]*__vinext_local_font|<link rel="stylesheet"[^>]*\.css/,
      );
    } finally {
      server?.close();
      await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);
});
