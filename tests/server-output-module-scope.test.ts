import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import vinext from "../packages/vinext/src/index.js";

// https://github.com/cloudflare/vinext/issues/4565: Next.js gives its generated
// Server Actions entry an `.mjs` extension so a `"type": "commonjs"` project
// still loads it (vercel/next.js#101164). vinext scopes the server output as ESM.
async function emittedAssets(packageType: string | undefined, environmentName: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-module-scope-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(packageType === undefined ? {} : { type: packageType }),
  );
  const plugins = vinext() as any[];
  const configPlugin = plugins.find((p) => p.name === "vinext:config");
  await configPlugin.config({ root, build: {}, plugins: [] }, { command: "build" });
  const plugin = plugins.find((p) => p.name === "vinext:server-output-module-scope");
  const emitted: Array<{ fileName: string; source: string }> = [];
  plugin.generateBundle.call({
    environment: {
      name: environmentName,
      config: { consumer: environmentName === "client" ? "client" : "server" },
    },
    emitFile: (file: { fileName: string; source: string }) => emitted.push(file),
  });
  fs.rmSync(root, { recursive: true, force: true });
  return emitted;
}

describe("vinext:server-output-module-scope", () => {
  it("marks the server output as ESM in a CommonJS package scope", async () => {
    expect(await emittedAssets("commonjs", "rsc")).toEqual([
      { type: "asset", fileName: "package.json", source: '{"type":"module"}\n' },
    ]);
  });

  it("leaves ESM and untyped projects alone", async () => {
    expect(await emittedAssets("module", "rsc")).toEqual([]);
    expect(await emittedAssets(undefined, "rsc")).toEqual([]);
  });

  it("never writes into the client output", async () => {
    expect(await emittedAssets("commonjs", "client")).toEqual([]);
  });
});
