import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { describeMissingBuildOutput } from "../packages/vinext/src/server/prod-server.js";

// https://github.com/cloudflare/vinext/issues/2966
// `vinext start` is the Node server. A Cloudflare build emits the Worker to
// dist/<worker-name>/ with a wrangler.json beside it, so the Node server finds
// nothing; the message must point at the command that runs that build.
describe("describeMissingBuildOutput", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  function tmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-start-"));
    dirs.push(dir);
    return dir;
  }

  it("asks for a build when dist has no Worker output", () => {
    const lines = describeMissingBuildOutput(tmp(), "dist");
    expect(lines.join("\n")).toContain("No build output found in dist");
    expect(lines.join("\n")).toContain("vite build");
    expect(lines.join("\n")).not.toContain("Cloudflare");
  });

  it("points a Cloudflare build at vite preview and wrangler", () => {
    const outDir = tmp();
    fs.mkdirSync(path.join(outDir, "my-app"));
    fs.writeFileSync(path.join(outDir, "my-app", "wrangler.json"), "{}");
    const text = describeMissingBuildOutput(outDir, "dist").join("\n");
    expect(text).toContain("Cloudflare Workers build");
    expect(text).toContain("vite preview");
    expect(text).toContain(`wrangler dev --config ${path.join("dist", "my-app", "wrangler.json")}`);
  });
});
