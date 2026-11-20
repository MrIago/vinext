/**
 * App Router on Workers needs `cloudflare({ viteEnvironment: { name: "rsc",
 * childEnvironments: ["ssr"] } })`. With a bare `cloudflare()` the plugin
 * creates its own Worker environment named after the Wrangler worker, the RSC
 * entry is bundled there without @vitejs/plugin-rsc, and the build dies deep
 * in Rolldown on `virtual:vite-rsc/encryption-key`. vinext must catch this at
 * config time and print the exact fix instead.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConfig } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

type CloudflarePluginFactory = (opts?: {
  viteEnvironment?: { name: string; childEnvironments?: string[] };
}) => import("vite").PluginOption;

const cfPluginPath = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-app-basic/node_modules/@cloudflare/vite-plugin/dist/index.mjs",
);

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(root: string, file: string, content: string) {
  const abs = path.join(root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function makeAppRouterWorker(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cf-env-guard-"));
  tmpDirs.push(root);
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  writeFile(root, "package.json", JSON.stringify({ name: "cf-env-guard", type: "module" }));
  writeFile(
    root,
    "wrangler.jsonc",
    JSON.stringify({
      name: "cf-env-guard",
      compatibility_date: "2026-02-12",
      compatibility_flags: ["nodejs_compat"],
      main: "./worker/index.ts",
    }),
  );
  writeFile(root, "worker/index.ts", 'export { default } from "vinext/server/app-router-entry";\n');
  writeFile(
    root,
    "app/layout.tsx",
    "export default function Layout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>;\n}\n",
  );
  writeFile(root, "app/page.tsx", "export default function Page() {\n  return <p>hi</p>;\n}\n");
  return root;
}

async function loadCloudflare(): Promise<CloudflarePluginFactory> {
  const mod = (await import(pathToFileURL(cfPluginPath).href)) as {
    cloudflare: CloudflarePluginFactory;
  };
  return mod.cloudflare;
}

describe("cloudflare() viteEnvironment guard", () => {
  it(
    "rejects an App Router build whose cloudflare() is not bound to the rsc environment",
    { timeout: 30_000 },
    async () => {
      const root = makeAppRouterWorker();
      const cloudflare = await loadCloudflare();
      await expect(
        resolveConfig(
          {
            root,
            configFile: false,
            logLevel: "silent",
            plugins: [vinext({ appDir: root }), cloudflare()],
          },
          "build",
        ),
      ).rejects.toThrow(
        /cloudflare\(\) runs the Worker in the "cf_env_guard" environment[\s\S]*viteEnvironment: \{ name: "rsc", childEnvironments: \["ssr"\] \}/,
      );
    },
  );

  it("accepts the documented cloudflare() configuration", { timeout: 30_000 }, async () => {
    const root = makeAppRouterWorker();
    const cloudflare = await loadCloudflare();
    const config = await resolveConfig(
      {
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [
          vinext({ appDir: root }),
          cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
        ],
      },
      "build",
    );
    expect(config.environments.rsc).toBeDefined();
  });
});
