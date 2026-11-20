/**
 * The `ensureStatic` segment config of Cache Components routes.
 *
 * A segment exports `ensureStatic` (or Next.js's earlier
 * `unstable_ensureStatic`) to require parts of its route to be statically
 * prerendered. `"navigation"`, the strictest level, makes the whole page
 * static: uncached and runtime data are rejected even behind Suspense, every
 * dynamic param comes from `generateStaticParams`, and a param the build
 * didn't generate is prerendered blocking instead of served from a fallback
 * shell.
 *
 * Ported from Next.js:
 * packages/next/src/server/app-render/segment-config/ensure-static.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/segment-config/ensure-static.ts
 */
import { isUnknownRecord } from "../utils/record.js";

export type EnsureStatic = "auto" | "shell" | "prefetch" | "navigation" | false;

/**
 * The route's resolved `ensureStatic`, ordered from least to most constrained.
 * Each level implies the ones before it.
 */
export const EnsureStaticLevel = {
  /** The route follows standard Partial Prefetching semantics. */
  None: 0,
  /** App Shells must be statically prerendered. */
  Shell: 1,
  /** App Shells and prefetches must be statically prerendered. */
  Prefetch: 2,
  /** App Shells, prefetches and the whole page must be statically prerendered. */
  Navigation: 3,
} as const;

export type EnsureStaticLevelValue = (typeof EnsureStaticLevel)[keyof typeof EnsureStaticLevel];

/** A segment of a route's tree, with the parallel routes rendered below it. */
export type EnsureStaticTree = {
  config: EnsureStatic;
  filePath: string | null;
  parallelRoutes: Readonly<Record<string, EnsureStaticTree>>;
};

type EnsureStaticWithSource = {
  config: EnsureStatic;
  filePath: string | null;
};

const ENSURE_STATIC_VALUES: readonly EnsureStatic[] = [
  "auto",
  "shell",
  "prefetch",
  "navigation",
  false,
];

function isEnsureStatic(value: unknown): value is EnsureStatic {
  return ENSURE_STATIC_VALUES.includes(value as EnsureStatic);
}

/** A segment module's `ensureStatic`, `"auto"` when it has none. */
export function readEnsureStaticExport(mod: unknown, filePath?: string | null): EnsureStatic {
  if (!isUnknownRecord(mod)) return "auto";
  const value = mod.ensureStatic !== undefined ? mod.ensureStatic : mod.unstable_ensureStatic;
  if (value === undefined) return "auto";
  if (!isEnsureStatic(value)) {
    throw new Error(
      `Invalid ensureStatic value ${JSON.stringify(value)}${filePath ? ` on "${filePath}"` : ""}, must be "auto", "shell", "prefetch", "navigation", or false.`,
    );
  }
  return value;
}

const ENSURE_STATIC_SOURCE_RE =
  /export\s+const\s+(?:unstable_)?ensureStatic(?:\s*:\s*[\w.<>[\]|'" ]+)?\s*=\s*(?:(["'`])(auto|shell|prefetch|navigation)\1|(false))/;

/**
 * A segment's `ensureStatic` read from its source, for the build, which
 * classifies routes without loading their modules.
 */
export function readEnsureStaticFromSource(code: string): EnsureStatic {
  const match = ENSURE_STATIC_SOURCE_RE.exec(code);
  if (!match) return "auto";
  if (match[3] === "false") return false;
  return match[2] as EnsureStatic;
}

function getEnsureStaticLevel(config: EnsureStatic): EnsureStaticLevelValue {
  switch (config) {
    case "auto":
    case false:
      return EnsureStaticLevel.None;
    case "shell":
      return EnsureStaticLevel.Shell;
    case "prefetch":
      return EnsureStaticLevel.Prefetch;
    case "navigation":
      return EnsureStaticLevel.Navigation;
  }
}

const Comparison = {
  LessConstrained: 1,
  Compatible: 2,
  MoreConstrained: 3,
  Incompatible: 4,
} as const;

type ComparisonValue = (typeof Comparison)[keyof typeof Comparison];

const ENSURE_STATIC_ORDER: readonly EnsureStatic[] = ["shell", "prefetch", "navigation"];

function compareEnsureStatic(left: EnsureStatic, right: EnsureStatic): ComparisonValue {
  // "auto" is compatible with everything.
  if (left === "auto" || right === "auto") return Comparison.Compatible;
  if (left === false && right === false) return Comparison.Compatible;
  if (left === false || right === false) return Comparison.Incompatible;
  const leftSort = ENSURE_STATIC_ORDER.indexOf(left);
  const rightSort = ENSURE_STATIC_ORDER.indexOf(right);
  return leftSort < rightSort
    ? Comparison.LessConstrained
    : leftSort === rightSort
      ? Comparison.Compatible
      : Comparison.MoreConstrained;
}

function formatParallelSlot(slot: string): string {
  return slot === "children" ? slot : `@${slot}`;
}

function formatEnsureStaticExport(config: EnsureStatic): string {
  return `export const ensureStatic = ${JSON.stringify(config)}`;
}

function resolveEnsureStaticConfigImpl(tree: EnsureStaticTree): EnsureStaticWithSource {
  const parentResult: EnsureStaticWithSource = { config: tree.config, filePath: tree.filePath };

  // Parallel slots must agree; compatible slots resolve to the most
  // constrained of them.
  let slotsResult: EnsureStaticWithSource | null = null;
  let slotResultKey: string | null = null;
  for (const [parallelRouteKey, parallelRoute] of Object.entries(tree.parallelRoutes)) {
    const childResult = resolveEnsureStaticConfigImpl(parallelRoute);
    if (!slotsResult) {
      slotsResult = childResult;
      slotResultKey = parallelRouteKey;
      continue;
    }
    if (compareEnsureStatic(childResult.config, slotsResult.config) === Comparison.Compatible) {
      if (slotsResult.config === "auto" && childResult.config !== "auto") {
        slotsResult = childResult;
        slotResultKey = parallelRouteKey;
      }
      continue;
    }
    throw new Error(
      `Parallel slots cannot have incompatible \`ensureStatic\`.` +
        `\n  ${formatParallelSlot(slotResultKey!)}: ` +
        `\n    ${formatEnsureStaticExport(slotsResult.config)}` +
        `\n    (from: ${slotsResult.filePath})` +
        `\n` +
        `\n  ${formatParallelSlot(parallelRouteKey)}: ` +
        `\n    ${formatEnsureStaticExport(childResult.config)}` +
        `\n    (from: ${childResult.filePath})` +
        `\n` +
        `\n Possible fixes:` +
        `\n - Remove one of the \`ensureStatic\` exports` +
        `\n - Change one of the  \`ensureStatic\` exports to match the other`,
    );
  }

  // A child segment can make its parent's config more constrained, never less.
  if (!slotsResult) return parentResult;
  const comparison = compareEnsureStatic(slotsResult.config, parentResult.config);
  switch (comparison) {
    case Comparison.Compatible:
      return parentResult.config === "auto" && slotsResult.config !== "auto"
        ? slotsResult
        : parentResult;
    case Comparison.MoreConstrained:
      return slotsResult;
    case Comparison.LessConstrained:
    case Comparison.Incompatible:
      throw new Error(
        (comparison === Comparison.LessConstrained
          ? `A child segment cannot override a parent segment with a less-constrained \`ensureStatic\`.`
          : `A child segment cannot override a parent segment with an incompatible \`ensureStatic\`.`) +
          `\n  Parent has: ` +
          `\n    ${formatEnsureStaticExport(parentResult.config)}` +
          `\n    (from: ${parentResult.filePath})` +
          `\n  Child has: ` +
          `\n    ${formatEnsureStaticExport(slotsResult.config)}` +
          `\n    (from: ${slotsResult.filePath})` +
          `\n` +
          `\n Possible fixes:` +
          `\n - Remove one of the \`ensureStatic\` exports` +
          `\n - Change one of the  \`ensureStatic\` exports to match the other`,
      );
  }
}

/**
 * The route's `ensureStatic`. Without Partial Prefetching, only `"prefetch"`
 * (Cache Components' own behavior) and `"navigation"` mean anything: `"auto"`
 * resolves to `"prefetch"`, and `"shell"` and `false` warn and do too.
 */
export function resolveEnsureStaticConfig(
  tree: EnsureStaticTree,
  partialPrefetching: boolean,
  warn: (message: string) => void = console.warn,
): Exclude<EnsureStatic, false> {
  let { config, filePath } = resolveEnsureStaticConfigImpl(tree);
  if (!partialPrefetching) {
    if (config === "auto") {
      config = "prefetch";
    } else if (config === false || config === "shell") {
      warn(
        `${formatEnsureStaticExport(config)} has no effect unless the route is using Partial Prefetching.` +
          `\n  (from: ${filePath})`,
      );
      config = "prefetch";
    }
  }
  return config === false ? "auto" : config;
}

export function resolveEnsureStaticLevel(
  tree: EnsureStaticTree,
  partialPrefetching: boolean,
  warn?: (message: string) => void,
): EnsureStaticLevelValue {
  return getEnsureStaticLevel(resolveEnsureStaticConfig(tree, partialPrefetching, warn));
}

type EnsureStaticSlot<TSegment> = {
  configLayouts?: readonly (TSegment | null | undefined)[] | null;
  default?: TSegment | null;
  layout?: TSegment | null;
  layoutIndex?: number;
  page?: TSegment | null;
};

/**
 * Build a route's segment tree, as Next.js's loader tree nests it: each layout
 * renders the next one as `children` beside the slots at its level, and the
 * innermost renders the page. A slot without a level belongs to the innermost
 * layout.
 */
export function createEnsureStaticTree<TSegment>(
  route: {
    layouts: readonly (TSegment | null | undefined)[];
    page: TSegment | null | undefined;
    slots: Readonly<Record<string, EnsureStaticSlot<TSegment>>>;
  },
  readSegment: (segment: TSegment) => { config: EnsureStatic; filePath: string | null },
): EnsureStaticTree {
  const leaf = (segment: TSegment | null | undefined): EnsureStaticTree => ({
    ...(segment ? readSegment(segment) : { config: "auto", filePath: null }),
    parallelRoutes: {},
  });
  const chain = (segments: readonly (TSegment | null | undefined)[]): EnsureStaticTree => {
    const [first, ...rest] = segments;
    const node = leaf(first);
    return rest.length === 0 ? node : { ...node, parallelRoutes: { children: chain(rest) } };
  };
  const innermost = route.layouts.length - 1;
  const build = (index: number): EnsureStaticTree => {
    if (index > innermost) return leaf(route.page);
    const parallelRoutes: Record<string, EnsureStaticTree> = { children: build(index + 1) };
    for (const [name, slot] of Object.entries(route.slots)) {
      const slotIndex =
        slot.layoutIndex === undefined || slot.layoutIndex < 0 ? innermost : slot.layoutIndex;
      if (slotIndex !== index) continue;
      parallelRoutes[name] = chain([
        ...(slot.configLayouts ?? []),
        slot.layout,
        slot.page ?? slot.default,
      ]);
    }
    return { ...leaf(route.layouts[index]), parallelRoutes };
  };
  return build(0);
}

//====================================================
// Errors for `ensureStatic = "navigation"` routes
//====================================================

/**
 * Ported from Next.js:
 * packages/next/src/shared/lib/errors/ensure-static-gsp-errors.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/errors/ensure-static-gsp-errors.ts
 */
export function createMissingGspErrorInStaticRoute(page: string): Error {
  return new Error(
    `Page "${page}": \`ensureStatic = "navigation"\` requires an exported \`generateStaticParams()\` function.\nLearn more: https://nextjs.org/docs/messages/generate-static-params#with-ensurestatic`,
  );
}

export function createIncompleteStaticParamsErrorInStaticRoute(
  page: string,
  missingParamNames: readonly string[],
): Error {
  return new Error(
    `Page "${page}": \`generateStaticParams()\` returned incomplete params. Routes using \`ensureStatic = "navigation"\` must return every dynamic route parameter. Missing: ${missingParamNames.map((name) => `"${name}"`).join(", ")}.\nLearn more: https://nextjs.org/docs/messages/generate-static-params#with-ensurestatic`,
  );
}

/** The message Next.js gives every Cache Components route with an empty generateStaticParams. */
export function createEmptyStaticParamsError(): Error {
  return new Error(
    "When using Cache Components, all `generateStaticParams` functions must return at least one result. " +
      "This is to ensure that we can perform build-time validation that there is no other dynamic accesses that would cause a runtime error.\n\n" +
      "Learn more: https://nextjs.org/docs/messages/empty-generate-static-params",
  );
}

/**
 * A prerender of an `ensureStatic = "navigation"` route that left part of the
 * page for request time. vinext tells a partial prerender apart, not which
 * data made it partial, so it reports Next.js's error for either kind.
 *
 * Ported from Next.js: packages/next/src/server/app-render/blocking-route-messages.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/blocking-route-messages.ts
 */
export function createNonPrerenderableBodyErrorInStaticRoute(route: string): Error {
  return new Error(
    `Route "${route}": Next.js encountered uncached or runtime data on a route that must be fully static.\n\n` +
      `This route is configured to be fully static, but some data requires rendering at request time.\n\n` +
      `Ways to fix this:\n` +
      `  - [cache] For uncached data (\`fetch\`, database calls): cache the access with \`"use cache"\` (does not apply to \`connection()\`)\n` +
      `  - [remove] Remove the data access\n` +
      `  - [client] Read the data on the client\n\n` +
      `Learn more: https://nextjs.org/docs/messages/static-route-dynamic`,
  );
}

/** The route's param names a generated set leaves out, in route order. */
export function findMissingStaticParamNames(
  paramNames: readonly string[],
  paramSets: readonly Record<string, unknown>[],
): string[] {
  return paramNames.filter((name) => paramSets.some((params) => !(name in params)));
}

type EnsureStaticRouteModules = {
  layouts: readonly unknown[];
  page?: unknown;
  pattern: string;
  slots?: Readonly<Record<string, EnsureStaticSlot<unknown>>>;
};

const routeLevels = new WeakMap<object, EnsureStaticLevelValue>();

/**
 * The resolved `ensureStatic` level of a route from its loaded segment
 * modules, computed once per production route. Only `"navigation"` changes how vinext
 * renders and serves the route.
 */
export function resolveRouteEnsureStaticLevel(
  route: EnsureStaticRouteModules,
  partialPrefetching = false,
): EnsureStaticLevelValue {
  const cached = routeLevels.get(route);
  if (cached !== undefined) return cached;
  let layoutNumber = 0;
  const tree = createEnsureStaticTree<unknown>(
    { layouts: route.layouts, page: route.page, slots: route.slots ?? {} },
    (mod) => {
      const filePath = `${route.pattern} (segment ${++layoutNumber})`;
      return { config: readEnsureStaticExport(mod, filePath), filePath };
    },
  );
  const level = resolveEnsureStaticLevel(tree, partialPrefetching, () => {});
  // Dev keeps the route object across edits to its modules.
  if (process.env.NODE_ENV === "production") routeLevels.set(route, level);
  return level;
}

/** Whether a route's segments export `ensureStatic = "navigation"`. */
export function isEnsureStaticNavigationRoute(route: EnsureStaticRouteModules): boolean {
  return resolveRouteEnsureStaticLevel(route) === EnsureStaticLevel.Navigation;
}
