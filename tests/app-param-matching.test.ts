import { describe, expect, it } from "vite-plus/test";
import {
  createParamMatchingTree,
  getParamMatchingFallbackMode,
  getResolvedClosedParamNames,
  isParamMatchingFallbackShellAllowed,
  resolveParamMatching,
  resolveParamMatchingAdmission,
  resolveRouteParamMatching,
  validateParamMatchingCoherence,
  validateParamMatchingParams,
  type ParamMatching,
  type ParamMatchingRoute,
} from "../packages/vinext/src/server/app-param-matching.js";

type Mod = Record<string, unknown>;

/**
 * A generated App route with the given modules. `layouts` pairs each layout
 * module with the number of route segments above it, as `layoutTreePositions`.
 */
function route(options: {
  layouts?: [Mod, number][];
  page?: Mod;
  pattern: string;
  rootParamNames?: string[];
  routeSegments: string[];
  slots?: ParamMatchingRoute["slots"];
}): ParamMatchingRoute {
  const params = options.routeSegments.flatMap((segment) => {
    const match = /^\[{1,2}(?:\.\.\.)?([^\]]+)\]{1,2}$/.exec(segment);
    return match ? [match[1]] : [];
  });
  return {
    layouts: (options.layouts ?? [[{}, 0]]).map(([mod]) => mod),
    layoutTreePositions: (options.layouts ?? [[{}, 0]]).map(([, position]) => position),
    page: options.page ?? {},
    params,
    pattern: options.pattern,
    rootParamNames: options.rootParamNames ?? [],
    routeSegments: options.routeSegments,
    slots: options.slots ?? null,
  };
}

function resolve(target: ParamMatchingRoute) {
  return resolveParamMatching(target.pattern, createParamMatchingTree(target), target.params);
}

// Ported from Next.js: packages/next/src/build/static-paths/app.test.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/build/static-paths/app.test.ts
describe("resolveParamMatching", () => {
  it("starts a descendant generator while its ancestor is still pending", async () => {
    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolveGate) => {
      releaseParent = resolveGate;
    });
    let notifyChildStarted!: () => void;
    const childStarted = new Promise<void>((resolveStarted) => {
      notifyChildStarted = resolveStarted;
    });

    const resolved = resolve(
      route({
        pattern: "/:lang/:top",
        routeSegments: ["[lang]", "[top]"],
        layouts: [
          [{}, 0],
          [
            {
              async unstable_generateParamMatching() {
                await parentGate;
                return { lang: "not-found" };
              },
            },
            1,
          ],
          [
            {
              async unstable_generateParamMatching() {
                notifyChildStarted();
                return { top: "blocking" };
              },
            },
            2,
          ],
        ],
      }),
    );

    // The child must not wait for the parent, but it need not start in the
    // same synchronous turn as resolveParamMatching.
    await childStarted;
    releaseParent();
    await expect(resolved).resolves.toEqual({ lang: "not-found", top: "blocking" });
  });

  it("is undefined when no segment configures parameter matching", async () => {
    await expect(
      resolve(route({ pattern: "/:lang", routeSegments: ["[lang]"] })),
    ).resolves.toBeUndefined();
  });

  it("merges layouts toward the page, overriding only the keys a descendant supplies", async () => {
    await expect(
      resolve(
        route({
          pattern: "/:lang/catalog/:top/items/:bottom",
          routeSegments: ["[lang]", "catalog", "[top]", "items", "[bottom]"],
          layouts: [
            [{}, 0],
            [{ unstable_paramMatching: { lang: "not-found" } }, 1],
          ],
          page: { unstable_paramMatching: { top: "blocking", bottom: "fallback" } },
        }),
      ),
    ).resolves.toEqual({ lang: "not-found", top: "blocking", bottom: "fallback" });
  });
});

// Ported from Next.js: test/e2e/app-dir/param-matching-exports/param-matching-exports.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/param-matching-exports/param-matching-exports.test.ts
describe("parameter matching exports", () => {
  const layoutRoute = (layout: Mod) =>
    route({
      pattern: "/:lang/:top",
      routeSegments: ["[lang]", "[top]"],
      layouts: [
        [{}, 0],
        [layout, 1],
      ],
    });

  it.each([
    [
      "static-below",
      { unstable_paramMatching: { top: "blocking" } },
      "may only configure parameters defined at or above its segment",
    ],
    [
      "static-function",
      { unstable_paramMatching: () => ({ lang: "not-found" }) },
      "Expected an object, but received function",
    ],
    [
      "generated-object",
      { unstable_generateParamMatching: { lang: "not-found" } },
      "must export `unstable_generateParamMatching` as a function",
    ],
    [
      "static-invalid-mode",
      { unstable_paramMatching: { lang: "closed" } },
      'Invalid mode for parameter "lang"',
    ],
  ])("rejects %s in the exporting layout", (_fixture, layout, message) => {
    expect(() => createParamMatchingTree(layoutRoute(layout))).toThrow(message);
  });

  it.each([
    [
      "generated-below",
      async () => ({ top: "blocking" }),
      "may only configure parameters defined at or above its segment",
    ],
    [
      "generated-invalid-mode",
      async () => ({ lang: "closed" }),
      'Invalid mode for parameter "lang"',
    ],
    ["generated-null", async () => null, "Expected an object, but received null"],
  ])("rejects %s from the exporting layout's generator", async (_fixture, generate, message) => {
    await expect(
      resolve(layoutRoute({ unstable_generateParamMatching: generate })),
    ).rejects.toThrow(message);
  });

  it("propagates generator failures", async () => {
    await expect(
      resolve(
        layoutRoute({
          async unstable_generateParamMatching() {
            throw new Error("MATCHER_GENERATOR_FAILURE");
          },
        }),
      ),
    ).rejects.toThrow("MATCHER_GENERATOR_FAILURE");
  });

  it("rejects both export forms in one module", () => {
    expect(() =>
      createParamMatchingTree(
        layoutRoute({
          unstable_paramMatching: { lang: "not-found" },
          async unstable_generateParamMatching() {
            return {};
          },
        }),
      ),
    ).toThrow("cannot export both `unstable_paramMatching` and `unstable_generateParamMatching`");
  });

  it("rejects the edge runtime", () => {
    expect(() =>
      createParamMatchingTree(
        layoutRoute({ runtime: "edge", unstable_paramMatching: { lang: "not-found" } }),
      ),
    ).toThrow("cannot use both `export const runtime = 'edge'` and parameter matching");
  });

  it("requires cacheComponents", async () => {
    await expect(
      resolveRouteParamMatching(layoutRoute({ unstable_paramMatching: { lang: "not-found" } }), {
        cacheComponents: false,
      }),
    ).rejects.toThrow("cannot use parameter matching without enabling `cacheComponents`");
  });
});

// Ported from Next.js: test/production/app-dir/param-matching-route-groups/param-matching-route-groups.test.ts
// https://github.com/vercel/next.js/blob/canary/test/production/app-dir/param-matching-route-groups/param-matching-route-groups.test.ts
describe("parallel route order", () => {
  const sidebarSlot = (page: Mod, routeSegments = ["[top]", "[bottom]"]) => ({
    sidebar: {
      default: {},
      layoutIndex: 0,
      name: "sidebar",
      ownerTreePosition: 0,
      page,
      routeSegments,
    },
  });

  it.each([
    ["aligned", ["[top]", "[bottom]"], ["[top]", "[bottom]"]],
    ["grouped-sidebar", ["[top]", "[bottom]"], ["(group)", "[top]", "[bottom]"]],
    ["grouped-children", ["(group)", "[top]", "[bottom]"], ["[top]", "[bottom]"]],
  ])(
    "uses URL parameter order regardless of the depth of a parallel branch: %s",
    async (_fixture, routeSegments, sidebarSegments) => {
      await expect(
        resolve(
          route({
            pattern: "/:top/:bottom",
            routeSegments,
            page: { unstable_paramMatching: { top: "blocking", bottom: "fallback" } },
            slots: sidebarSlot(
              {
                async unstable_generateParamMatching() {
                  return { top: "blocking", bottom: "fallback" };
                },
              },
              sidebarSegments,
            ),
          }),
        ),
      ).resolves.toEqual({ top: "blocking", bottom: "fallback" });
    },
  );

  it("rejects policies that become incoherent through composition: incompatible", async () => {
    await expect(
      resolve(
        route({
          pattern: "/:top/:bottom",
          routeSegments: ["[top]", "[bottom]"],
          page: { unstable_paramMatching: { top: "fallback" } },
          slots: sidebarSlot({ unstable_paramMatching: { bottom: "blocking" } }),
        }),
      ),
    ).rejects.toThrow(
      'parameter "bottom" uses "blocking" after parameter "top" uses a later matching phase',
    );
  });

  it("rejects policies that become incoherent through composition: inherited-not-found", async () => {
    await expect(
      resolve(
        route({
          pattern: "/:top/:bottom",
          routeSegments: ["[top]", "[bottom]"],
          layouts: [
            [{}, 0],
            [{ unstable_paramMatching: { top: "blocking" } }, 1],
          ],
          page: { unstable_paramMatching: { bottom: "not-found" } },
        }),
      ),
    ).rejects.toThrow(
      'parameter "bottom" uses "not-found" after parameter "top" uses a later matching phase',
    );
  });
});

// Ported from Next.js: test/production/app-dir/param-matching-parallel-inheritance/param-matching-parallel-inheritance.test.ts
// https://github.com/vercel/next.js/blob/canary/test/production/app-dir/param-matching-parallel-inheritance/param-matching-parallel-inheritance.test.ts
describe("parallel inheritance", () => {
  const langRoute = (page: Mod, main: Mod, sidebar: Mod) =>
    route({
      pattern: "/:lang",
      routeSegments: ["[lang]"],
      layouts: [
        [{}, 0],
        [{ unstable_paramMatching: { lang: "not-found" } }, 1],
      ],
      page,
      slots: {
        main: { layoutIndex: 1, name: "main", ownerTreePosition: 1, page: main, routeSegments: [] },
        sidebar: {
          layoutIndex: 1,
          name: "sidebar",
          ownerTreePosition: 1,
          page: sidebar,
          routeSegments: [],
        },
      },
    });

  it("rejects an override that conflicts with a sibling inherited policy", async () => {
    // All slots match /[lang]. Opening @main must not also open @sidebar,
    // which still inherits lang: 'not-found' from their shared layout.
    await expect(
      resolve(langRoute({}, { unstable_paramMatching: { lang: "blocking" } }, {})),
    ).rejects.toThrow('conflicting parallel parameter matching modes for parameter "lang"');
  });

  it("allows all parallel branches to explicitly replace the inherited policy", async () => {
    const blocking = { unstable_paramMatching: { lang: "blocking" } };
    await expect(resolve(langRoute(blocking, blocking, blocking))).resolves.toEqual({
      lang: "blocking",
    });
  });

  // Ported from Next.js: test/production/app-dir/param-matching-not-found (parallel-missing)
  it("rejects not-found in one branch when another branch has no policy", async () => {
    await expect(
      resolve(
        route({
          pattern: "/:lang",
          routeSegments: ["[lang]"],
          layouts: [
            [{}, 0],
            [{}, 1],
          ],
          page: { unstable_paramMatching: { lang: "not-found" } },
          slots: {
            other: {
              layoutIndex: 1,
              name: "other",
              ownerTreePosition: 1,
              page: {},
              routeSegments: [],
            },
          },
        }),
      ),
    ).rejects.toThrow("another branch has no explicit policy");
  });
});

describe("closed prefixes", () => {
  it("requires every parameter before a not-found one to be explicitly not-found", async () => {
    await expect(
      resolve(
        route({
          pattern: "/:lang/:slug",
          routeSegments: ["[lang]", "[slug]"],
          page: { unstable_paramMatching: { slug: "not-found" } },
        }),
      ),
    ).rejects.toThrow(
      'Parameter "lang" must explicitly configure "not-found" before parameter "slug" uses "not-found"',
    );
  });
});

// Ported from Next.js: test/production/app-dir/param-matching-not-found/param-matching-not-found.test.ts
// https://github.com/vercel/next.js/blob/canary/test/production/app-dir/param-matching-not-found/param-matching-not-found.test.ts
describe("not-found parameter coherence", () => {
  const closed = { lang: "not-found" } satisfies ParamMatching;

  it.each([
    ["explicit-mismatch", { "/:lang/a": closed, "/:lang/b": { lang: "blocking" } }, "/:lang/b"],
    ["missing-sibling", { "/:lang/a": closed, "/:lang/b": undefined }, "/:lang/b"],
    ["missing-policy-key", { "/:lang/a": closed, "/:lang/b/:slug": {} }, "/:lang/b/:slug"],
    ["missing-ancestor", { "/:lang/a": closed, "/:lang": undefined }, "/:lang"],
  ] as const)(
    "rejects a parameter that is not closed in every route: %s",
    (_fixture, policies, openRoute) => {
      let message = "";
      try {
        validateParamMatchingCoherence(new Map(Object.entries(policies)));
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain('Parameter "lang"');
      expect(message).toContain('must explicitly configure "not-found"');
      expect(message).toContain("/:lang/a");
      expect(message).toContain(openRoute);
    },
  );

  it("accepts inheritance, explicit agreement, and unrelated parameter definitions", () => {
    expect(() =>
      validateParamMatchingCoherence(
        new Map<string, ParamMatching | undefined>([
          ["/:lang/a", closed],
          ["/:lang/b", closed],
          ["/products/:slug", { slug: "not-found" }],
          ["/blog/:slug", undefined],
          ["/explicit/:locale/a", { locale: "not-found" }],
          ["/explicit/:locale/b", { locale: "not-found" }],
          ["/open/:id/a", { id: "blocking" }],
          ["/open/:id/b", undefined],
        ]),
      ),
    ).not.toThrow();
  });
});

describe("validateParamMatchingParams", () => {
  const names = ["top", "bottom"];

  it("rejects a prerendered parameter after a dynamic one", () => {
    expect(() =>
      validateParamMatchingParams(
        "/:top/:bottom",
        { top: "dynamic" },
        new Set(["bottom"]),
        new Set(),
        names,
        undefined,
      ),
    ).toThrow(
      'cannot prerender parameter "bottom" because parameter "top" is configured as "dynamic"',
    );
  });

  it("rejects a not-found parameter generateStaticParams left out", () => {
    expect(() =>
      validateParamMatchingParams(
        "/:top/:bottom",
        { top: "not-found" },
        new Set(),
        new Set(["top"]),
        names,
        undefined,
      ),
    ).toThrow("generateStaticParams returned a result without that parameter");
  });

  it('requires every parameter to be not-found with output: "export"', () => {
    expect(() =>
      validateParamMatchingParams(
        "/:top/:bottom",
        { top: "not-found" },
        new Set(names),
        new Set(),
        names,
        "export",
      ),
    ).toThrow('must configure parameter "bottom" as "not-found"');
  });
});

describe("getParamMatchingFallbackMode", () => {
  const none = new Set<string>();

  it("lets the first explicitly configured unresolved parameter decide", () => {
    const policy: ParamMatching = { lang: "not-found", top: "blocking", bottom: "fallback" };
    expect(getParamMatchingFallbackMode(policy, ["lang", "top", "bottom"], undefined, none)).toBe(
      "not-found",
    );
    expect(getParamMatchingFallbackMode(policy, ["top", "bottom"], undefined, none)).toBe(
      "blocking",
    );
    expect(getParamMatchingFallbackMode(policy, ["bottom"], undefined, none)).toBe("prerender");
    expect(getParamMatchingFallbackMode({ bottom: "dynamic" }, ["bottom"], undefined, none)).toBe(
      "prerender",
    );
  });

  it("keeps the inferred mode for unconfigured parameters", () => {
    expect(getParamMatchingFallbackMode({}, ["slug"], "not-found", none)).toBe("not-found");
    expect(getParamMatchingFallbackMode({}, ["slug"], undefined, none)).toBeUndefined();
  });

  // Ported from Next.js: test/production/app-dir/param-matching-root-fallback
  it("keeps root parameters blocking while a later not-found still rejects", () => {
    const root = new Set(["lang"]);
    expect(
      getParamMatchingFallbackMode({ bottom: "fallback" }, ["lang", "bottom"], "prerender", root),
    ).toBe("blocking");
    expect(getParamMatchingFallbackMode({}, ["lang"], "prerender", root)).toBe("blocking");
  });
});

describe("resolveParamMatchingAdmission", () => {
  // The example from vercel/next.js#97393.
  const paramMatching: ParamMatching = { lang: "not-found", top: "blocking", bottom: "fallback" };
  const generated = [{ lang: "en", top: "t1", bottom: "b1" }];
  const admission = (params: Record<string, string>) =>
    resolveParamMatchingAdmission({
      dynamicParams: undefined,
      isGenerated: (paramNames) =>
        generated.some((row) =>
          paramNames.every((name) => row[name as keyof typeof row] === params[name]),
        ),
      paramMatching,
      rootParamNames: [],
      routeParamNames: ["lang", "top", "bottom"],
    });

  it("serves a generated path as its own prerender", () => {
    expect(admission({ lang: "en", top: "t1", bottom: "b1" })).toEqual({
      fallbackMode: undefined,
      resolvedParamCount: 3,
    });
  });

  it("rejects another language", () => {
    expect(admission({ lang: "fr", top: "t1", bottom: "b1" }).fallbackMode).toBe("not-found");
  });

  it("blocks a novel top", () => {
    expect(admission({ lang: "en", top: "t2", bottom: "b2" })).toEqual({
      fallbackMode: "blocking",
      resolvedParamCount: 1,
    });
  });

  it("gives a novel bottom a fallback shell", () => {
    expect(admission({ lang: "en", top: "t1", bottom: "b2" })).toEqual({
      fallbackMode: "prerender",
      resolvedParamCount: 2,
    });
  });

  it("lets an explicit policy open a route with dynamicParams = false", () => {
    expect(
      resolveParamMatchingAdmission({
        dynamicParams: false,
        isGenerated: () => false,
        paramMatching: { slug: "blocking" },
        rootParamNames: [],
        routeParamNames: ["slug"],
      }).fallbackMode,
    ).toBe("blocking");
    expect(
      resolveParamMatchingAdmission({
        dynamicParams: false,
        isGenerated: () => false,
        paramMatching: {},
        rootParamNames: [],
        routeParamNames: ["slug"],
      }).fallbackMode,
    ).toBe("not-found");
  });
});

describe("isParamMatchingFallbackShellAllowed", () => {
  const policy: ParamMatching = { lang: "not-found", top: "blocking", bottom: "fallback" };

  it("keeps only shells that leave a fallback boundary unknown", () => {
    expect(isParamMatchingFallbackShellAllowed(policy, ["bottom"], [])).toBe(true);
    expect(isParamMatchingFallbackShellAllowed(policy, ["top", "bottom"], [])).toBe(false);
    expect(isParamMatchingFallbackShellAllowed(policy, ["lang", "top", "bottom"], [])).toBe(false);
    expect(isParamMatchingFallbackShellAllowed(undefined, ["lang"], [])).toBe(true);
  });
});

describe("resolveRouteParamMatching", () => {
  it("records the closed parameters of a resolved route", async () => {
    const target = route({
      pattern: "/products/:slug",
      routeSegments: ["products", "[slug]"],
      page: { unstable_paramMatching: { slug: "not-found" } },
    });
    await resolveRouteParamMatching(target, { cacheComponents: true });
    expect(getResolvedClosedParamNames(target)).toEqual(["slug"]);
  });

  it("evaluates a generator once per evaluation of the route's modules", async () => {
    let calls = 0;
    const target = route({
      pattern: "/:lang",
      routeSegments: ["[lang]"],
      page: {
        async unstable_generateParamMatching() {
          calls++;
          return { lang: "not-found" };
        },
      },
    });
    await resolveRouteParamMatching(target, { cacheComponents: true });
    await resolveRouteParamMatching(target, { cacheComponents: true });
    expect(calls).toBe(1);

    // A changed module, as dev reloads one, evaluates the route again.
    target.page = { ...target.page };
    await resolveRouteParamMatching(target, { cacheComponents: true });
    expect(calls).toBe(2);
  });
});
