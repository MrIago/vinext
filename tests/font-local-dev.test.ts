import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { describe, expect, it, vi } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-basic");

function adjustedFallbackCSS(code: string): string | undefined {
  const match = /adjustedFallbackCSS: ("(?:[^"\\]|\\.)*")/.exec(code);
  return match ? JSON.parse(match[1]) : undefined;
}

function sizeAdjust(css: string | undefined): string | undefined {
  return css && /size-adjust: ([\d.]+%)/.exec(css)?.[1];
}

describe("next/font/local adjustFontFallback in dev", () => {
  it("regenerates the fallback face in every environment when the font changes", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-font-local-dev-")));
    const fontFile = path.join(root, "app", "font.woff2");
    fs.mkdirSync(path.dirname(fontFile));
    fs.symlinkSync(
      path.join(process.cwd(), "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    fs.copyFileSync(path.join(FIXTURE_DIR, "app/script-nonce/with-next-font/font.woff2"), fontFile);
    fs.writeFileSync(
      path.join(root, "app", "font.ts"),
      `import localFont from "next/font/local";\n` +
        `export const roboto = localFont({ src: "./font.woff2" });\n`,
    );
    fs.writeFileSync(
      path.join(root, "app", "layout.tsx"),
      `export default function RootLayout({ children }) { return <html><body>{children}</body></html>; }\n`,
    );
    fs.writeFileSync(path.join(root, "app", "page.tsx"), `export default () => null;\n`);

    const server = await createServer({
      root,
      configFile: false,
      cacheDir: path.join(root, ".vite"),
      logLevel: "silent",
      plugins: [vinext({ appDir: root })],
      server: { port: 0 },
    });
    const environments = Object.values(server.environments);
    const sizeAdjustByEnvironment = async () =>
      Object.fromEntries(
        await Promise.all(
          environments.map(async (environment) => {
            const result = await environment.transformRequest("/app/font.ts");
            return [environment.name, sizeAdjust(adjustedFallbackCSS(result!.code))];
          }),
        ),
      );

    try {
      expect(environments.map((environment) => environment.name)).toEqual(
        expect.arrayContaining(["client", "ssr", "rsc"]),
      );
      // Roboto and Noto Sans against Arial, as in font-local-transform.test.ts.
      const expectAll = (value: string) =>
        Object.fromEntries(environments.map((environment) => [environment.name, value]));
      expect(await sizeAdjustByEnvironment()).toEqual(expectAll("100.30%"));

      fs.copyFileSync(path.join(FIXTURE_DIR, "assets/noto-sans.ttf"), fontFile);

      // The rsc and ssr environments only soft-invalidate a module that
      // statically imports the changed font; it must still re-run the
      // transform there rather than keep the old metrics.
      await vi.waitFor(
        async () => expect(await sizeAdjustByEnvironment()).toEqual(expectAll("106.47%")),
        { timeout: 10_000, interval: 100 },
      );
    } finally {
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("next/font/local extracted @font-face CSS in dev", () => {
  // Next.js serves next/font/local's @font-face rules from the build's CSS
  // in dev too, not from an inline <style>:
  // https://github.com/vercel/next.js/blob/canary/packages/font/src/local/loader.ts
  async function startDevServer(files: Record<string, string>, router: "app" | "pages") {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-font-local-css-")));
    fs.symlinkSync(
      path.join(process.cwd(), "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    for (const [file, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), contents);
    }
    fs.copyFileSync(
      path.join(FIXTURE_DIR, "app/script-nonce/with-next-font/font.woff2"),
      path.join(root, router, "font.woff2"),
    );
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: path.join(root, ".vite"),
      logLevel: "silent",
      plugins: [vinext(router === "app" ? { appDir: root } : {})],
      server: { port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address();
    const baseUrl = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;
    return {
      baseUrl,
      async close() {
        await server.close();
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  }

  async function expectExtractedFontFace(baseUrl: string) {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    expect(inline.join("\n")).not.toContain("@font-face");
    expect(inline.join("\n")).toContain("'roboto', 'roboto Fallback', sans-serif");
    const href = /<link[^>]*rel="stylesheet"[^>]*href="([^"]*__vinext_local_font_[^"]+)"/.exec(
      html,
    )?.[1];
    expect(href).toBeDefined();
    const cssUrl = href!.replaceAll("&amp;", "&");
    const css = await (
      await fetch(`${baseUrl}${cssUrl}${cssUrl.includes("?") ? "&" : "?"}direct`)
    ).text();
    expect(css).toContain("font-family: 'roboto'");
    expect(css).toContain("font-family: 'roboto Fallback'");
    const fontUrl = /url\(['"]?([^'")]+\.woff2)['"]?\)/.exec(css)?.[1];
    expect(fontUrl).toBeDefined();
    expect((await fetch(`${baseUrl}${fontUrl}`)).status).toBe(200);
  }

  it("links the stylesheet from a font declared in its own module (App Router)", async () => {
    // Ported from Next.js: test/e2e/next-font/with-font-declarations-file.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/next-font/with-font-declarations-file.test.ts
    const server = await startDevServer(
      {
        "app/fonts.ts": `import localFont from "next/font/local";\nexport const roboto = localFont({ src: "./font.woff2" });\n`,
        "app/layout.tsx": `import { roboto } from "./fonts";\nexport default function RootLayout({ children }) { return <html><body className={roboto.className}>{children}</body></html>; }\n`,
        "app/page.tsx": `export default () => <p>hello</p>;\n`,
      },
      "app",
    );
    try {
      await expectExtractedFontFace(server.baseUrl);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("links the stylesheet from a font declared in _app (Pages Router)", async () => {
    const server = await startDevServer(
      {
        "pages/_app.tsx": `import localFont from "next/font/local";\nconst roboto = localFont({ src: "./font.woff2" });\nexport default function App({ Component, pageProps }) { return <main className={roboto.className}><Component {...pageProps} /></main>; }\n`,
        "pages/index.tsx": `export default () => <p>hello</p>;\n`,
      },
      "pages",
    );
    try {
      await expectExtractedFontFace(server.baseUrl);
    } finally {
      await server.close();
    }
  }, 30_000);
});
