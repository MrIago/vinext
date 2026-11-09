import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createValidFileMatcher } from "../packages/vinext/src/routing/file-matcher.js";
import {
  collectAppStructure,
  findStrictRouteMatchingErrors,
} from "../packages/vinext/src/routing/strict-route-matching-check.js";

// Ported from Next.js's strict route matching fixtures (vercel/next.js#97397):
// test/e2e/app-dir/incompatible-parallel-route-slots,
// test/e2e/app-dir/unmatched-app-pages and
// test/e2e/app-dir/canonical-interception-routes.
const roots: string[] = [];
function app(files: Record<string, string>): { root: string; appDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-strict-routes-"));
  roots.push(root);
  const appDir = path.join(root, "app");
  for (const [file, source] of Object.entries(files)) {
    const filePath = path.join(appDir, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
  }
  return { root, appDir };
}
const component = "export default function C() { return null }";
const matcher = createValidFileMatcher();

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("strict route matching check", () => {
  it("collects page and default app paths like Next.js", () => {
    const { appDir } = app({
      "page.tsx": component,
      "(shop)/@modal/(.)item/[id]/page.tsx": component,
      "@modal/default.tsx": component,
      "_private/page.tsx": component,
      "layout.tsx": component,
    });
    const structure = collectAppStructure(appDir, matcher);
    expect(structure.appPagePaths).toEqual({
      "/": ["/page"],
      "/(.)item/[id]": ["/(shop)/@modal/(.)item/[id]/page"],
    });
    expect(structure.defaultAppPaths).toEqual(["/@modal/default"]);
    expect(structure.layoutFiles.has("/")).toBe(true);
  });

  it("accepts a complete parallel route tree", () => {
    const { root, appDir } = app({
      "layout.tsx": component,
      "page.tsx": component,
      "@sidebar/page.tsx": component,
      "about/page.tsx": component,
      "@sidebar/default.tsx": component,
    });
    expect(findStrictRouteMatchingErrors({ appDir, root, matcher })).toEqual([]);
  });

  it("reports a slot without a matching page or default", () => {
    const { root, appDir } = app({
      "layout.tsx": component,
      "page.tsx": component,
      "@sidebar/page.tsx": component,
      "about/page.tsx": component,
    });
    const [error] = findStrictRouteMatchingErrors({ appDir, root, matcher });
    expect(error?.name).toBe("IncompatibleParallelRouteSlotsError");
    expect(error?.message).toContain("app/layout.tsx");
    expect(error?.message).toContain(
      "- /about is missing a matching page or default.tsx in @sidebar",
    );
  });

  it("reports an interception route without a canonical route", () => {
    const { root, appDir } = app({
      "layout.tsx": component,
      "page.tsx": component,
      "@modal/default.tsx": component,
      "@modal/(.)photo/[id]/page.tsx": component,
    });
    const errors = findStrictRouteMatchingErrors({ appDir, root, matcher });
    expect(errors.map((error) => error.name)).toContain("MissingCanonicalInterceptionRoutesError");
    expect(errors[0]?.message).toContain("(expected /photo/[id])");
  });
});
