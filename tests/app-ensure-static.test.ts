import { describe, expect, it, vi } from "vite-plus/test";
import {
  createEnsureStaticTree,
  EnsureStaticLevel,
  readEnsureStaticExport,
  readEnsureStaticFromSource,
  resolveEnsureStaticConfig,
  resolveRouteEnsureStaticLevel,
  type EnsureStatic,
} from "../packages/vinext/src/server/app-ensure-static.js";

// Ported from Next.js's ensureStatic resolution:
// packages/next/src/server/app-render/segment-config/ensure-static.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/segment-config/ensure-static.ts
// and its config validation suite:
// test/e2e/app-dir/ensure-static-config-validation/ensure-static-config-validation.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/ensure-static-config-validation/ensure-static-config-validation.test.ts

type Segment = { config: EnsureStatic; name: string };

function treeOf(route: {
  layouts: EnsureStatic[];
  page: EnsureStatic;
  slots?: Record<string, { page: EnsureStatic; layoutIndex?: number }>;
}) {
  const segment = (config: EnsureStatic, name: string): Segment => ({ config, name });
  return createEnsureStaticTree<Segment>(
    {
      layouts: route.layouts.map((config, index) => segment(config, `layout ${index}`)),
      page: segment(route.page, "page"),
      slots: Object.fromEntries(
        Object.entries(route.slots ?? {}).map(([name, slot]) => [
          name,
          { layoutIndex: slot.layoutIndex, page: segment(slot.page, `@${name}`) },
        ]),
      ),
    },
    ({ config, name }) => ({ config, filePath: name }),
  );
}

describe("ensureStatic", () => {
  it("reads the export and Next.js's earlier unstable_ spelling", () => {
    expect(readEnsureStaticExport({ ensureStatic: "navigation" })).toBe("navigation");
    expect(readEnsureStaticExport({ unstable_ensureStatic: "navigation" })).toBe("navigation");
    expect(readEnsureStaticExport({ ensureStatic: false })).toBe(false);
    expect(readEnsureStaticExport({ default: () => null })).toBe("auto");
    expect(readEnsureStaticExport(undefined)).toBe("auto");
    expect(() => readEnsureStaticExport({ ensureStatic: "always" }, "app/page.tsx")).toThrow(
      'Invalid ensureStatic value "always" on "app/page.tsx", must be "auto", "shell", "prefetch", "navigation", or false.',
    );
  });

  it("reads the export from a segment's source", () => {
    expect(readEnsureStaticFromSource(`export const ensureStatic = 'navigation'`)).toBe(
      "navigation",
    );
    expect(readEnsureStaticFromSource(`export const unstable_ensureStatic = "prefetch";`)).toBe(
      "prefetch",
    );
    expect(readEnsureStaticFromSource(`export const ensureStatic: EnsureStatic = "shell"`)).toBe(
      "shell",
    );
    expect(readEnsureStaticFromSource(`export const ensureStatic = false`)).toBe(false);
    expect(readEnsureStaticFromSource(`export default function Page() {}`)).toBe("auto");
  });

  it("takes the most constrained config of the route", () => {
    expect(resolveEnsureStaticConfig(treeOf({ layouts: ["auto"], page: "navigation" }), true)).toBe(
      "navigation",
    );
    expect(
      resolveEnsureStaticConfig(treeOf({ layouts: ["prefetch"], page: "navigation" }), true),
    ).toBe("navigation");
    expect(
      resolveEnsureStaticConfig(treeOf({ layouts: ["navigation", "auto"], page: "auto" }), true),
    ).toBe("navigation");
    expect(resolveEnsureStaticConfig(treeOf({ layouts: ["auto"], page: false }), true)).toBe(
      "auto",
    );
  });

  it("rejects a child less constrained than its parent", () => {
    expect(() =>
      resolveEnsureStaticConfig(treeOf({ layouts: ["navigation"], page: "shell" }), true),
    ).toThrow(
      "A child segment cannot override a parent segment with a less-constrained `ensureStatic`.",
    );
    expect(() =>
      resolveEnsureStaticConfig(treeOf({ layouts: ["prefetch"], page: false }), true),
    ).toThrow(
      "A child segment cannot override a parent segment with an incompatible `ensureStatic`.",
    );
  });

  it("rejects parallel slots that disagree, and takes the constrained one of compatible slots", () => {
    expect(() =>
      resolveEnsureStaticConfig(
        treeOf({ layouts: ["auto"], page: "navigation", slots: { panel: { page: "shell" } } }),
        true,
      ),
    ).toThrow("Parallel slots cannot have incompatible `ensureStatic`.");
    expect(
      resolveEnsureStaticConfig(
        treeOf({ layouts: ["auto"], page: "auto", slots: { panel: { page: "navigation" } } }),
        true,
      ),
    ).toBe("navigation");
  });

  it("attaches a slot to the layout at its level", () => {
    // A slot beside the outer layout's children is compared with the whole
    // inner subtree, which is navigation.
    const tree = treeOf({
      layouts: ["auto", "navigation"],
      page: "auto",
      slots: { panel: { layoutIndex: 0, page: "prefetch" } },
    });
    expect(Object.keys(tree.parallelRoutes)).toEqual(["children", "panel"]);
    expect(() => resolveEnsureStaticConfig(tree, true)).toThrow(
      "Parallel slots cannot have incompatible `ensureStatic`.",
    );
  });

  it("gives only prefetch and navigation a meaning without Partial Prefetching", () => {
    const warn = vi.fn();
    expect(resolveEnsureStaticConfig(treeOf({ layouts: [], page: "auto" }), false, warn)).toBe(
      "prefetch",
    );
    expect(warn).not.toHaveBeenCalled();
    expect(resolveEnsureStaticConfig(treeOf({ layouts: [], page: "shell" }), false, warn)).toBe(
      "prefetch",
    );
    expect(warn).toHaveBeenCalledWith(
      'export const ensureStatic = "shell" has no effect unless the route is using Partial Prefetching.\n  (from: page)',
    );
    expect(
      resolveEnsureStaticConfig(treeOf({ layouts: [], page: "navigation" }), false, warn),
    ).toBe("navigation");
  });

  it("resolves a loaded route's level from its modules", () => {
    expect(
      resolveRouteEnsureStaticLevel({
        layouts: [{ default: () => null, ensureStatic: "navigation" }],
        page: { default: () => null },
        pattern: "/blog/:slug",
      }),
    ).toBe(EnsureStaticLevel.Navigation);
    expect(
      resolveRouteEnsureStaticLevel({
        layouts: [{ default: () => null }],
        page: { default: () => null },
        pattern: "/blog/:slug",
        slots: { panel: { page: { default: () => null, unstable_ensureStatic: "navigation" } } },
      }),
    ).toBe(EnsureStaticLevel.Navigation);
    expect(
      resolveRouteEnsureStaticLevel({
        layouts: [{ default: () => null }],
        page: { default: () => null },
        pattern: "/blog/:slug",
      }),
    ).toBe(EnsureStaticLevel.Prefetch);
  });
});
