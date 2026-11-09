/**
 * Cache Components parameter matching: `unstable_paramMatching` and
 * `unstable_generateParamMatching`.
 *
 * A policy configures, per dynamic parameter, what a value that
 * generateStaticParams did not produce gets: a 404 (`not-found`), a blocking
 * render (`blocking`), a fallback shell (`fallback`), or a render that never
 * prerenders the parameter (`dynamic`). Policies merge from layouts toward
 * pages, and every parallel branch that reaches a parameter must agree.
 *
 * Ported from Next.js:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/build/static-paths/param-matching.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/build/segment-config/app/app-segments.ts
 * (vercel/next.js#97393)
 */

export const PARAM_MATCHING_MODES = ["not-found", "blocking", "fallback", "dynamic"] as const;

export type ParamMatchingMode = (typeof PARAM_MATCHING_MODES)[number];

export type ParamMatching = Record<string, ParamMatchingMode>;

/**
 * What a request whose first unresolved parameters are these gets, as Next.js's
 * `FallbackMode`: `not-found` (NOT_FOUND), `blocking`
 * (BLOCKING_STATIC_RENDER) or `prerender` (PRERENDER, a fallback shell).
 * Undefined keeps the route's inferred behavior.
 */
export type ParamMatchingFallbackMode = "not-found" | "blocking" | "prerender";

type ParamMatchingExport = ParamMatching | (() => Promise<ParamMatching>);

/** A layout, page or default module of a route, with the params it can configure. */
export type ParamMatchingSegment = {
  /** A description of the module for error messages. */
  filePath: string | undefined;
  paramMatching: ParamMatchingExport | undefined;
  /** The params defined at or above the module's segment, in URL order. */
  visibleParamNames: readonly string[];
};

/** A segment and its children, keeping parallel branches apart for inheritance. */
export type ParamMatchingTree = [segment: ParamMatchingSegment, children: ParamMatchingTree[]];

type ParamMatchingModule = Record<string, unknown> | null | undefined;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateParamMatchingExport(
  route: string,
  filePath: string | undefined,
  exportName: string,
  value: unknown,
  visibleParamNames: readonly string[],
): ParamMatching {
  if (!isPlainObject(value)) {
    const valueType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    throw new Error(
      `Invalid value from \`${exportName}\` for "${route}". Expected an object, but received ${valueType}.`,
    );
  }

  const paramMatching: ParamMatching = {};
  for (const [paramName, mode] of Object.entries(value)) {
    if (!visibleParamNames.includes(paramName)) {
      throw new Error(
        `Invalid parameter "${paramName}" in \`${exportName}\` for "${route}". The export in "${filePath}" may only configure parameters defined at or above its segment.`,
      );
    }
    if (!PARAM_MATCHING_MODES.includes(mode as ParamMatchingMode)) {
      throw new Error(
        `Invalid mode for parameter "${paramName}" in \`${exportName}\` for "${route}". Expected "not-found", "blocking", "fallback", or "dynamic", but received ${JSON.stringify(mode)}.`,
      );
    }
    paramMatching[paramName] = mode as ParamMatchingMode;
  }

  return paramMatching;
}

/** Whether a module exports either parameter matching form. */
export function hasParamMatchingExport(mod: ParamMatchingModule): boolean {
  return (
    mod !== null &&
    mod !== undefined &&
    ("unstable_paramMatching" in mod || "unstable_generateParamMatching" in mod)
  );
}

/**
 * A module's parameter matching export, validated as Next.js attaches it to
 * the segment. A generator is wrapped, not called: it runs when the route's
 * policy is resolved, inside the static generation scope.
 */
export function readParamMatchingExport(
  route: string,
  filePath: string | undefined,
  mod: ParamMatchingModule,
  visibleParamNames: readonly string[],
): ParamMatchingExport | undefined {
  if (!hasParamMatchingExport(mod)) return undefined;
  const userland = mod as Record<string, unknown>;
  const hasStatic = "unstable_paramMatching" in userland;
  const hasGenerated = "unstable_generateParamMatching" in userland;

  if (hasStatic && hasGenerated) {
    throw new Error(
      `Route "${route}" cannot export both \`unstable_paramMatching\` and \`unstable_generateParamMatching\`.`,
    );
  }
  if (userland.runtime === "edge" || userland.runtime === "experimental-edge") {
    throw new Error(
      `Page "${route}" cannot use both \`export const runtime = 'edge'\` and parameter matching.`,
    );
  }

  if (hasStatic) {
    return validateParamMatchingExport(
      route,
      filePath,
      "unstable_paramMatching",
      userland.unstable_paramMatching,
      visibleParamNames,
    );
  }

  const generate = userland.unstable_generateParamMatching;
  if (typeof generate !== "function") {
    throw new Error(
      `Route "${route}" must export \`unstable_generateParamMatching\` as a function.`,
    );
  }
  return async () =>
    validateParamMatchingExport(
      route,
      filePath,
      "unstable_generateParamMatching",
      await (generate as () => unknown)(),
      visibleParamNames,
    );
}

/** A route handler cannot configure parameter matching. */
export function assertRouteHandlerHasNoParamMatching(
  route: string,
  mod: ParamMatchingModule,
): void {
  if (hasParamMatchingExport(mod)) {
    throw new Error(
      `Route "${route}" cannot export parameter matching. It is only supported in layouts and pages.`,
    );
  }
}

type PolicyCandidate = {
  readonly mode: ParamMatchingMode;
  readonly filePath: string | undefined;
};

/**
 * The route's effective policy: each segment's export merged down its branch,
 * descendants overriding only the keys they supply, and every leaf agreeing.
 * Undefined when no segment configures parameter matching.
 */
export async function resolveParamMatching(
  page: string,
  segmentTree: readonly ParamMatchingTree[],
  pathnameParamNames: readonly string[],
): Promise<ParamMatching | undefined> {
  const configuredSegments: ParamMatchingSegment[] = [];
  const nodes = [...segmentTree];
  for (let index = 0; index < nodes.length; index++) {
    const [segment, children] = nodes[index];
    if (segment.paramMatching !== undefined) configuredSegments.push(segment);
    nodes.push(...children);
  }

  if (configuredSegments.length === 0) return undefined;

  const routeParamNames = new Set(pathnameParamNames);
  const candidates = new Map<string, PolicyCandidate[]>();
  const paramsMissingPolicy = new Set<string>();
  // Start independent generators together, before merging their results down
  // each branch.
  const fragments = new Map<ParamMatchingSegment, ParamMatching>();
  await Promise.all(
    configuredSegments.map(async (segment) => {
      const paramMatchingExport = segment.paramMatching!;
      const value =
        typeof paramMatchingExport === "function"
          ? await paramMatchingExport()
          : paramMatchingExport;
      for (const paramName of Object.keys(value)) {
        if (!routeParamNames.has(paramName)) {
          const exportName =
            typeof paramMatchingExport === "function"
              ? "unstable_generateParamMatching"
              : "unstable_paramMatching";
          throw new Error(
            `Invalid parameter "${paramName}" in \`${exportName}\` for "${page}". Parameter matching may only configure dynamic parameters in this route.`,
          );
        }
      }
      fragments.set(segment, value);
    }),
  );

  function visit(
    [segment, children]: ParamMatchingTree,
    inherited: ReadonlyMap<string, PolicyCandidate>,
  ) {
    const branchCandidates = new Map(inherited);
    const fragment = fragments.get(segment);
    if (fragment) {
      for (const [paramName, mode] of Object.entries(fragment)) {
        branchCandidates.set(paramName, { mode, filePath: segment.filePath });
      }
    }

    if (children.length > 0) {
      for (const child of children) visit(child, branchCandidates);
      return;
    }

    // Compare the effective policies at every leaf, including leaves without
    // exports. A sibling's override must not erase this branch's inheritance.
    for (const paramName of segment.visibleParamNames) {
      if (routeParamNames.has(paramName) && !branchCandidates.has(paramName)) {
        paramsMissingPolicy.add(paramName);
      }
    }

    for (const [paramName, candidate] of branchCandidates) {
      const parallelCandidates = candidates.get(paramName);
      if (!parallelCandidates) {
        candidates.set(paramName, [candidate]);
      } else if (!parallelCandidates.some(({ mode }) => mode === candidate.mode)) {
        parallelCandidates.push(candidate);
      }
    }
  }
  for (const root of segmentTree) visit(root, new Map());

  const policy: ParamMatching = {};
  for (const paramName of pathnameParamNames) {
    const paramCandidates = candidates.get(paramName);
    if (!paramCandidates) continue;
    const mode = paramCandidates[0].mode;
    if (paramCandidates.some((candidate) => candidate.mode !== mode)) {
      const definitions = paramCandidates
        .map((candidate) => `${candidate.filePath ?? "<unknown module>"} (${candidate.mode})`)
        .join(", ");
      throw new Error(
        `Route "${page}" has conflicting parallel parameter matching modes for parameter "${paramName}": ${definitions}.`,
      );
    }
    if (mode === "not-found" && paramsMissingPolicy.has(paramName)) {
      throw new Error(
        `Parameter "${paramName}" in route "${page}" uses "not-found" in one parallel branch, but another branch has no explicit policy. Every parallel branch sharing this parameter must explicitly configure "not-found", either directly or through an inherited layout.`,
      );
    }
    policy[paramName] = mode;
  }

  let previousPhase = -1;
  let previousParamName: string | undefined;
  let unconfiguredPrefixParamName: string | undefined;
  for (const paramName of pathnameParamNames) {
    const mode = policy[paramName];
    if (!mode) {
      unconfiguredPrefixParamName ??= paramName;
      continue;
    }
    if (mode === "not-found" && unconfiguredPrefixParamName !== undefined) {
      throw new Error(
        `Invalid parameter matching for "${page}": Parameter "${unconfiguredPrefixParamName}" must explicitly configure "not-found" before parameter "${paramName}" uses "not-found". Configure the preceding parameter directly or in an inherited layout; it cannot be closed by inference.`,
      );
    }
    const currentPhase = PARAM_MATCHING_MODES.indexOf(mode);
    if (currentPhase < previousPhase) {
      throw new Error(
        `Invalid parameter matching for "${page}": parameter "${paramName}" uses "${mode}" after parameter "${previousParamName}" uses a later matching phase. Expected parameters in this order: "not-found", "blocking", "fallback", then "dynamic".`,
      );
    }
    previousPhase = currentPhase;
    previousParamName = paramName;
  }

  return policy;
}

/** The param a route pattern part (`:slug`, `:path+`, `:path*`) defines. */
function patternPartParamName(part: string): string | null {
  if (!part.startsWith(":")) return null;
  return part.endsWith("+") || part.endsWith("*") ? part.slice(1, -1) : part.slice(1);
}

/**
 * Validate closure after every page's policy has been resolved. A parameter
 * definition is identified by its URL prefix, including the parameter name:
 * `/blog/:slug` and `/shop/:slug` are independent, while route groups and
 * parallel slots share a definition when their URL prefixes match.
 * `paramMatchingByRoute` is keyed by vinext route pattern.
 */
export function validateParamMatchingCoherence(
  paramMatchingByRoute: ReadonlyMap<string, ParamMatching | undefined>,
): void {
  const parameters = new Map<string, [route: string, notFound: boolean]>();

  for (const [route, paramMatching] of [...paramMatchingByRoute].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    let prefix = "";
    for (const part of route.split("/")) {
      if (!part) continue;
      prefix += `/${part}`;
      const paramName = patternPartParamName(part);
      if (paramName === null) continue;

      const notFound = paramMatching?.[paramName] === "not-found";
      const previous = parameters.get(prefix);
      if (previous === undefined) {
        parameters.set(prefix, [route, notFound]);
      } else if (previous[1] !== notFound) {
        const closedRoute = notFound ? route : previous[0];
        const openRoute = notFound ? previous[0] : route;
        throw new Error(
          `Parameter "${paramName}" at "${prefix}" uses "not-found" in route "${closedRoute}". Route "${openRoute}" must explicitly configure "not-found" for this parameter, either directly or through an inherited layout.`,
        );
      }
    }
  }
}

/**
 * The mode for a request whose unresolved params are `fallbackParamNames`, in
 * URL order: the first explicitly configured one decides. Root params keep
 * their blocking inference, without stopping the walk, so a later explicit
 * `not-found` still rejects the whole match.
 */
export function getParamMatchingFallbackMode(
  paramMatching: Readonly<ParamMatching>,
  fallbackParamNames: readonly string[],
  inferredFallbackMode: ParamMatchingFallbackMode | undefined,
  rootParamKeys: ReadonlySet<string>,
): ParamMatchingFallbackMode | undefined {
  let hasInferredBlockingRoot = false;
  for (const paramName of fallbackParamNames) {
    switch (paramMatching[paramName]) {
      case undefined:
        if (rootParamKeys.has(paramName)) hasInferredBlockingRoot = true;
        break;
      case "not-found":
        return "not-found";
      case "blocking":
        return "blocking";
      case "fallback":
      case "dynamic":
        return hasInferredBlockingRoot ? "blocking" : "prerender";
    }
  }

  return hasInferredBlockingRoot ? "blocking" : inferredFallbackMode;
}

/**
 * Check a policy against what generateStaticParams produced: a param after an
 * explicitly dynamic one can't be prerendered, a `not-found` param must be in
 * every generated set, and `output: "export"` needs every param closed.
 */
export function validateParamMatchingParams(
  page: string,
  paramMatching: Readonly<ParamMatching>,
  generatedParamNames: ReadonlySet<string>,
  missingParamNames: ReadonlySet<string>,
  pathnameParamNames: readonly string[],
  output: "export" | "standalone" | undefined,
): void {
  let dynamicParamName: string | undefined;
  for (const paramName of pathnameParamNames) {
    const mode = paramMatching[paramName];
    if (mode === "dynamic") dynamicParamName = paramName;
    if (dynamicParamName && generatedParamNames.has(paramName)) {
      throw new Error(
        `Route "${page}" cannot prerender parameter "${paramName}" because parameter "${dynamicParamName}" is configured as "dynamic".`,
      );
    }
    if (mode === "not-found" && missingParamNames.has(paramName)) {
      throw new Error(
        `Route "${page}" configures parameter "${paramName}" as "not-found", but generateStaticParams returned a result without that parameter.`,
      );
    }
    if (output === "export" && mode !== "not-found") {
      throw new Error(
        `Route "${page}" must configure parameter "${paramName}" as "not-found" when using parameter matching with "output: export".`,
      );
    }
  }
}

/** The params generateStaticParams named and those some of its sets left out. */
export function collectGeneratedParamNames(
  pathnameParamNames: readonly string[],
  staticParams: readonly Record<string, unknown>[],
): { generatedParamNames: Set<string>; missingParamNames: Set<string> } {
  const generatedParamNames = new Set<string>();
  const missingParamNames = new Set<string>();
  if (staticParams.length > 0) {
    for (const paramName of pathnameParamNames) {
      for (const params of staticParams) {
        if (paramName in params) generatedParamNames.add(paramName);
        else missingParamNames.add(paramName);
      }
    }
  }
  return { generatedParamNames, missingParamNames };
}

// ── Routes ──────────────────────────────────────────────────────────────────

type ParamMatchingRouteSlot = {
  configLayouts?: readonly ParamMatchingModule[] | null;
  configLayoutTreePositions?: readonly number[] | null;
  default?: ParamMatchingModule;
  layout?: ParamMatchingModule;
  layoutIndex?: number;
  name?: string;
  ownerTreePosition?: number | null;
  page?: ParamMatchingModule;
  routeSegments?: readonly string[] | null;
  slotParamNames?: readonly string[] | null;
};

/** The parts of a generated App route the policy is read from. */
export type ParamMatchingRoute = {
  layouts: readonly ParamMatchingModule[];
  layoutTreePositions?: readonly number[];
  page?: ParamMatchingModule;
  params: readonly string[];
  pattern: string;
  rootParamNames?: readonly string[];
  routeSegments: readonly string[];
  slots?: Readonly<Record<string, ParamMatchingRouteSlot>> | null;
};

/** The param a filesystem segment (`[id]`, `[...path]`, `[[...path]]`) defines. */
function segmentParamName(segment: string): string | null {
  const match = /^\[{1,2}(?:\.\.\.)?([^\]]+)\]{1,2}$/.exec(segment);
  return match ? match[1] : null;
}

function segmentParamNames(segments: readonly string[]): string[] {
  const names: string[] = [];
  for (const segment of segments) {
    const name = segmentParamName(segment);
    if (name !== null && !names.includes(name)) names.push(name);
  }
  return names;
}

function describeModule(segments: readonly string[], file: string): string {
  return ["app", ...segments, file].join("/");
}

/**
 * The route's segment tree for parameter matching: its layouts down to the
 * page, with each parallel slot's layouts and page as a branch of the layout
 * that owns it, as Next.js keeps them in the loader tree.
 */
export function createParamMatchingTree(route: ParamMatchingRoute): ParamMatchingTree[] {
  const routeSegments = route.routeSegments;
  const layoutPositions = route.layoutTreePositions ?? [];
  const createNode = (
    mod: ParamMatchingModule,
    segments: readonly string[],
    file: string,
    visibleParamNames: readonly string[],
  ): ParamMatchingTree => {
    const filePath = describeModule(segments, file);
    return [
      {
        filePath,
        paramMatching: readParamMatchingExport(route.pattern, filePath, mod, visibleParamNames),
        visibleParamNames,
      },
      [],
    ];
  };

  const mainNodes: { node: ParamMatchingTree; treePosition: number }[] = [];
  route.layouts.forEach((layout, index) => {
    const treePosition = layoutPositions[index] ?? 0;
    const segments = routeSegments.slice(0, treePosition);
    mainNodes.push({
      node: createNode(layout, segments, "layout", segmentParamNames(segments)),
      treePosition,
    });
  });
  const pageNode = createNode(route.page, routeSegments, "page", segmentParamNames(routeSegments));

  // Chain the main layouts down to the page.
  for (let index = 0; index < mainNodes.length; index++) {
    const next = mainNodes[index + 1]?.node ?? pageNode;
    mainNodes[index].node[1].push(next);
  }

  const unownedBranches: ParamMatchingTree[] = [];
  for (const [slotKey, slot] of Object.entries(route.slots ?? {})) {
    const slotSegments = slot.routeSegments ?? [];
    const ownerPosition =
      slot.ownerTreePosition ?? Math.max(0, routeSegments.length - slotSegments.length);
    const ownerSegments = routeSegments.slice(0, ownerPosition);
    const ownerParamNames = segmentParamNames(ownerSegments);
    const slotName = `@${slot.name ?? slotKey}`;
    const slotBase = [...ownerSegments, slotName];
    const branchParamNames = (segments: readonly string[]) => {
      const names = [...ownerParamNames];
      for (const name of segmentParamNames(segments)) {
        if (!names.includes(name)) names.push(name);
      }
      return names;
    };

    const branch: ParamMatchingTree[] = [];
    if (slot.layout) branch.push(createNode(slot.layout, slotBase, "layout", ownerParamNames));
    (slot.configLayouts ?? []).forEach((layout, index) => {
      const position = slot.configLayoutTreePositions?.[index] ?? 0;
      const segments = slotSegments.slice(0, position);
      branch.push(
        createNode(layout, [...slotBase, ...segments], "layout", branchParamNames(segments)),
      );
    });
    const leafParamNames = branchParamNames(slotSegments);
    for (const name of slot.slotParamNames ?? []) {
      if (!leafParamNames.includes(name)) leafParamNames.push(name);
    }
    branch.push(
      createNode(
        slot.page ?? slot.default,
        [...slotBase, ...slotSegments],
        slot.page ? "page" : "default",
        leafParamNames,
      ),
    );
    for (let index = 0; index < branch.length - 1; index++) {
      branch[index][1].push(branch[index + 1]);
    }

    // The slot belongs to the deepest main layout at or above its owner.
    let owner: ParamMatchingTree | undefined;
    if (slot.layoutIndex !== undefined && slot.layoutIndex >= 0) {
      owner = mainNodes[slot.layoutIndex]?.node;
    }
    if (!owner) {
      for (const candidate of mainNodes) {
        if (candidate.treePosition <= ownerPosition) owner = candidate.node;
      }
    }
    // A route without layouts keeps the branch beside its page.
    if (owner) owner[1].push(branch[0]);
    else unownedBranches.push(branch[0]);
  }

  return mainNodes.length > 0 ? [mainNodes[0].node] : [pageNode, ...unownedBranches];
}

/** Whether any of the route's modules exports parameter matching. */
export function routeHasParamMatchingExport(route: ParamMatchingRoute): boolean {
  if (route.layouts.some(hasParamMatchingExport) || hasParamMatchingExport(route.page)) return true;
  return Object.values(route.slots ?? {}).some(
    (slot) =>
      hasParamMatchingExport(slot.layout) ||
      (slot.configLayouts ?? []).some(hasParamMatchingExport) ||
      hasParamMatchingExport(slot.page ?? slot.default),
  );
}

type ResolvedRouteParamMatching = {
  modules: readonly ParamMatchingModule[];
  policy: Promise<ParamMatching | undefined>;
  settled?: ParamMatching | undefined;
};

const resolvedRouteParamMatching = new WeakMap<object, ResolvedRouteParamMatching>();

function routeModules(route: ParamMatchingRoute): ParamMatchingModule[] {
  const modules: ParamMatchingModule[] = [...route.layouts, route.page];
  for (const slot of Object.values(route.slots ?? {})) {
    modules.push(slot.layout, ...(slot.configLayouts ?? []), slot.page ?? slot.default);
  }
  return modules;
}

/**
 * The route's effective policy, resolved once per set of its modules: Next.js
 * evaluates each generator once per route evaluation, and dev re-evaluates a
 * route when one of its modules changes. `run` wraps the generators, as the
 * static generation scope they run in.
 */
export function resolveRouteParamMatching(
  route: ParamMatchingRoute,
  options: {
    cacheComponents: boolean;
    run?: <T>(fn: () => Promise<T>) => Promise<T>;
  },
): Promise<ParamMatching | undefined> {
  const modules = routeModules(route);
  const cached = resolvedRouteParamMatching.get(route);
  if (
    cached &&
    cached.modules.length === modules.length &&
    cached.modules.every((mod, index) => mod === modules[index])
  ) {
    return cached.policy;
  }

  const entry: ResolvedRouteParamMatching = {
    modules,
    policy: Promise.resolve(undefined),
  };
  entry.policy = (async () => {
    if (!routeHasParamMatchingExport(route)) return undefined;
    if (!options.cacheComponents) {
      throw new Error(
        `Route "${route.pattern}" cannot use parameter matching without enabling \`cacheComponents\`.`,
      );
    }
    const tree = createParamMatchingTree(route);
    const resolve = () => resolveParamMatching(route.pattern, tree, route.params);
    return options.run ? options.run(resolve) : resolve();
  })();
  entry.policy.then(
    (policy) => {
      entry.settled = policy;
    },
    () => {
      // A failed resolution is retried by the next request, which reports it.
      if (resolvedRouteParamMatching.get(route) === entry) {
        resolvedRouteParamMatching.delete(route);
      }
    },
  );
  resolvedRouteParamMatching.set(route, entry);
  return entry.policy;
}

/**
 * The params a resolved policy closes (`not-found`), read synchronously by the
 * render once its request resolved the policy. Like Next.js's
 * `PrefetchHint.IsClosedParam`, they tell the client a URL's route depends on
 * them even when no component reads them.
 */
export function getResolvedClosedParamNames(route: object): readonly string[] {
  const policy = resolvedRouteParamMatching.get(route)?.settled;
  if (!policy) return [];
  return Object.keys(policy).filter((name) => policy[name] === "not-found");
}

/**
 * Where a request stands under a route's policy: the number of its params, in
 * URL order, that generateStaticParams produced a set agreeing on, as the most
 * specific Next.js prerender matcher for it, and the mode its remaining params
 * give it. A fully generated request has no mode.
 */
export function resolveParamMatchingAdmission(options: {
  dynamicParams: boolean | undefined;
  isGenerated: (paramNames: readonly string[]) => boolean;
  paramMatching: Readonly<ParamMatching>;
  routeParamNames: readonly string[];
  rootParamNames: readonly string[];
}): { fallbackMode: ParamMatchingFallbackMode | undefined; resolvedParamCount: number } {
  const { routeParamNames } = options;
  let resolvedParamCount = 0;
  for (let count = routeParamNames.length; count > 0; count--) {
    if (options.isGenerated(routeParamNames.slice(0, count))) {
      resolvedParamCount = count;
      break;
    }
  }
  if (resolvedParamCount === routeParamNames.length) {
    return { fallbackMode: undefined, resolvedParamCount };
  }
  return {
    fallbackMode: getParamMatchingFallbackMode(
      options.paramMatching,
      routeParamNames.slice(resolvedParamCount),
      options.dynamicParams === false ? "not-found" : "prerender",
      new Set(options.rootParamNames),
    ),
    resolvedParamCount,
  };
}

/**
 * Whether a fallback shell that leaves `fallbackParamNames` unknown may be
 * produced and served under the policy: only a `fallback` (or `dynamic`)
 * boundary has one. A `not-found` or `blocking` boundary renders the request's
 * own path instead.
 */
export function isParamMatchingFallbackShellAllowed(
  paramMatching: Readonly<ParamMatching> | undefined,
  fallbackParamNames: readonly string[],
  rootParamNames: readonly string[],
): boolean {
  if (!paramMatching) return true;
  const mode = getParamMatchingFallbackMode(
    paramMatching,
    fallbackParamNames,
    "prerender",
    new Set(rootParamNames),
  );
  return mode === "prerender";
}
