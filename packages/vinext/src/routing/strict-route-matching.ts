/**
 * Strict App Router route matching, ported from Next.js (#3365, #3122).
 *
 * A route must construct a complete parallel-route tree for every URL it
 * matches. Matchers derived from catch-alls that can only render a permanent
 * not-found tree are pruned, and invalid structures are reported:
 * incompatible parallel-route slots, pages no complete route reaches, and
 * interception routes without a canonical route.
 *
 * Ported verbatim (apart from the import plumbing) from Next.js:
 * - packages/next/src/server/lib/router-utils/normalize-catchall-routes.ts
 * - packages/next/src/shared/lib/router/utils/interception-routes.ts
 * - packages/next/src/shared/lib/errors/{missing-canonical-interception-routes,
 *   incompatible-parallel-route-slots,unmatched-app-pages}-error.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-utils/normalize-catchall-routes.ts
 */

// --- shared/lib/entry-constants.ts
const UNDERSCORE_NOT_FOUND_ROUTE = "/_not-found";
const UNDERSCORE_NOT_FOUND_ROUTE_ENTRY = `${UNDERSCORE_NOT_FOUND_ROUTE}/page`;
const UNDERSCORE_GLOBAL_ERROR_ROUTE = "/_global-error";
const UNDERSCORE_GLOBAL_ERROR_ROUTE_ENTRY = `${UNDERSCORE_GLOBAL_ERROR_ROUTE}/page`;

// --- lib/is-app-page-route.ts
export function isAppPageRoute(route: string): boolean {
  return route.endsWith("/page");
}

// --- shared/lib/router/utils/app-paths.ts (normalizeAppPath)
function isGroupSegment(segment: string): boolean {
  return segment[0] === "(" && segment.endsWith(")");
}

export function normalizeAppPath(route: string): string {
  const pathname = route.split("/").reduce((current, segment, index, segments) => {
    if (!segment) return current;
    if (isGroupSegment(segment)) return current;
    if (segment[0] === "@") return current;
    if ((segment === "page" || segment === "route") && index === segments.length - 1) {
      return current;
    }
    return `${current}/${segment}`;
  }, "");
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

// --- shared/lib/router/utils/interception-routes.ts

// order matters here, the first match will be used
export const INTERCEPTION_ROUTE_MARKERS = ["(..)(..)", "(.)", "(..)", "(...)"] as const;

export type InterceptionMarker = (typeof INTERCEPTION_ROUTE_MARKERS)[number];

export type MissingCanonicalInterceptionRoute = {
  interceptionRoute: string;
  canonicalRoute: string;
};

type RoutePattern = {
  prefix: Array<string | null>;
  minLength: number;
  unbounded: boolean;
};

function parseRoutePattern(route: string): RoutePattern {
  const segments = route.split("/").filter(Boolean);
  const tail = segments.at(-1);
  const isOptionalCatchAll = tail !== undefined && tail.startsWith("[[...") && tail.endsWith("]]");
  const isCatchAll = tail !== undefined && tail.startsWith("[...") && tail.endsWith("]");
  const unbounded = isOptionalCatchAll || isCatchAll;
  const prefixSegments = unbounded ? segments.slice(0, -1) : segments;

  return {
    prefix: prefixSegments.map((segment) =>
      segment.startsWith("[") && segment.endsWith("]") ? null : segment,
    ),
    minLength: prefixSegments.length + (isCatchAll && !isOptionalCatchAll ? 1 : 0),
    unbounded,
  };
}

function acceptsLength(pattern: RoutePattern, length: number): boolean {
  return pattern.unbounded ? length >= pattern.minLength : length === pattern.minLength;
}

function prefixCovers(canonical: RoutePattern, intercepted: RoutePattern): boolean {
  return canonical.prefix.every((canonicalSegment, index) => {
    if (canonicalSegment === null) return true;

    const interceptedSegment = intercepted.prefix[index];
    return (
      interceptedSegment !== undefined &&
      interceptedSegment !== null &&
      canonicalSegment === interceptedSegment
    );
  });
}

function patternCoversAtLength(
  canonical: RoutePattern,
  intercepted: RoutePattern,
  length: number,
): boolean {
  return (
    acceptsLength(canonical, length) &&
    acceptsLength(intercepted, length) &&
    prefixCovers(canonical, intercepted)
  );
}

/** Returns whether ordinary route patterns cover every URL in `route`. */
function isRoutePatternCovered(route: string, ordinaryRoutes: RoutePattern[]) {
  const intercepted = parseRoutePattern(route);

  if (!intercepted.unbounded) {
    return ordinaryRoutes.some((pattern) =>
      patternCoversAtLength(pattern, intercepted, intercepted.minLength),
    );
  }

  let unboundedCoverageStart = Infinity;
  for (const pattern of ordinaryRoutes) {
    if (pattern.unbounded && prefixCovers(pattern, intercepted)) {
      unboundedCoverageStart = Math.min(
        unboundedCoverageStart,
        Math.max(intercepted.minLength, pattern.minLength),
      );
    }
  }

  if (unboundedCoverageStart === Infinity) return false;

  // An optional or required catchall can have its shorter paths covered by
  // fixed routes before another catchall takes over the remaining suffix.
  for (let length = intercepted.minLength; length < unboundedCoverageStart; length++) {
    if (!ordinaryRoutes.some((pattern) => patternCoversAtLength(pattern, intercepted, length))) {
      return false;
    }
  }

  return true;
}

export function isInterceptionRouteAppPath(path: string): boolean {
  // TODO-APP: add more serious validation
  return (
    path
      .split("/")
      .find((segment) => INTERCEPTION_ROUTE_MARKERS.find((m) => segment.startsWith(m))) !==
    undefined
  );
}

type InterceptionRouteInformation = {
  /**
   * The intercepting route. This is the route that is being intercepted or the
   * route that the user was coming from. This is matched by the Next-Url
   * header.
   */
  interceptingRoute: string;

  /**
   * The intercepted route. This is the route that is being intercepted or the
   * route that the user is going to. This is matched by the request pathname.
   */
  interceptedRoute: string;
};

export function extractInterceptionRouteInformation(path: string): InterceptionRouteInformation {
  let interceptingRoute: string | undefined;
  let marker: (typeof INTERCEPTION_ROUTE_MARKERS)[number] | undefined;
  let interceptedRoute: string | undefined;

  for (const segment of path.split("/")) {
    marker = INTERCEPTION_ROUTE_MARKERS.find((m) => segment.startsWith(m));
    if (marker) {
      [interceptingRoute, interceptedRoute] = path.split(marker, 2);
      break;
    }
  }

  if (!interceptingRoute || !marker || !interceptedRoute) {
    throw new Error(
      `Invalid interception route: ${path}. Must be in the format /<intercepting route>/(..|...|..)(..)/<intercepted route>`,
    );
  }

  interceptingRoute = normalizeAppPath(interceptingRoute); // normalize the path, e.g. /(blog)/feed -> /feed

  switch (marker) {
    case "(.)":
      // (.) indicates that we should match with sibling routes, so we just need to append the intercepted route to the intercepting route
      if (interceptingRoute === "/") {
        interceptedRoute = `/${interceptedRoute}`;
      } else {
        interceptedRoute = interceptingRoute + "/" + interceptedRoute;
      }
      break;
    case "(..)":
      // (..) indicates that we should match at one level up, so we need to remove the last segment of the intercepting route
      if (interceptingRoute === "/") {
        throw new Error(
          `Invalid interception route: ${path}. Cannot use (..) marker at the root level, use (.) instead.`,
        );
      }
      interceptedRoute = interceptingRoute
        .split("/")
        .slice(0, -1)
        .concat(interceptedRoute)
        .join("/");
      break;
    case "(...)":
      // (...) will match the route segment in the root directory, so we need to use the root directory to prepend the intercepted route
      interceptedRoute = "/" + interceptedRoute;
      break;
    case "(..)(..)":
      // (..)(..) indicates that we should match at two levels up, so we need to remove the last two segments of the intercepting route

      const splitInterceptingRoute = interceptingRoute.split("/");
      if (splitInterceptingRoute.length <= 2) {
        throw new Error(
          `Invalid interception route: ${path}. Cannot use (..)(..) marker at the root level or one level up.`,
        );
      }

      interceptedRoute = splitInterceptingRoute.slice(0, -2).concat(interceptedRoute).join("/");
      break;
    default:
      throw new Error("Invariant: unexpected marker");
  }

  return { interceptingRoute, interceptedRoute };
}

/**
 * Finds interception matchers that cannot be loaded as an ordinary request.
 *
 * This must run after catch-all normalization and pruning so `appPaths`
 * contains the final matcher set rather than every possible matcher candidate.
 */
export function findMissingCanonicalInterceptionRoutes(
  appPaths: Record<string, string[]>,
): MissingCanonicalInterceptionRoute[] {
  const canonicalRoutes = Object.keys(appPaths).filter(
    (route) => !isInterceptionRouteAppPath(route),
  );
  const canonicalRoutePatterns = canonicalRoutes.map(parseRoutePattern);

  return Object.keys(appPaths)
    .filter(isInterceptionRouteAppPath)
    .map((interceptionRoute) => ({
      interceptionRoute,
      canonicalRoute: extractInterceptionRouteInformation(interceptionRoute).interceptedRoute,
    }))
    .filter(({ canonicalRoute }) => !isRoutePatternCovered(canonicalRoute, canonicalRoutePatterns))
    .sort((a, b) => a.interceptionRoute.localeCompare(b.interceptionRoute));
}

// --- server/lib/router-utils/normalize-catchall-routes.ts

type AppPathNormalizer = {
  normalize(pathname: string): string;
};

export type NormalizeCatchAllRoutesOptions = {
  strictRouteMatching?: boolean;
  defaultAppPaths?: Iterable<string>;
};

export type IncompatibleParallelRouteSlots = {
  layoutPath: string;
  route: string;
  missingSlots: string[];
};

export type NormalizeCatchAllRoutesResult = {
  unmatchedAppPages: string[];
  incompatibleParallelRouteSlots: IncompatibleParallelRouteSlots[];
};

type ParallelRouteLevel = {
  parentSegments: string[];
  namedSlots: Set<string>;
  hasChildrenSlot: boolean;
};

type ParallelRouteTopology = {
  allAppPaths: Set<string>;
  levelsByParent: Map<string, ParallelRouteLevel>;
};

const defaultNormalizer: AppPathNormalizer = {
  normalize(pathname: string): string {
    return normalizeAppPath(pathname).replace(/%5F/g, "_");
  },
};

/**
 * This function will transform the appPaths in order to support catch-all routes and parallel routes.
 * It will traverse the appPaths, looking for catch-all routes and try to find parallel routes that could match
 * the catch-all. If it finds a match, it will add the catch-all to the parallel route's list of possible routes.
 *
 * @param appPaths The appPaths to transform
 * @returns Page app paths that are not present in any retained matcher and
 * incompatible static matchers found before they were pruned.
 */
export function normalizeCatchAllRoutesWithNormalizer(
  appPaths: Record<string, string[]>,
  normalizer: AppPathNormalizer = defaultNormalizer,
  { strictRouteMatching = false, defaultAppPaths = [] }: NormalizeCatchAllRoutesOptions = {},
): NormalizeCatchAllRoutesResult {
  const pageAppPaths = strictRouteMatching
    ? new Set(Object.values(appPaths).flat().filter(isUserAppPageRoute))
    : undefined;
  const catchAllRoutes = [
    ...new Set(
      Object.values(appPaths)
        .flat()
        .filter(isCatchAllRoute)
        // Sorting is important because we want to match the most specific path.
        .sort((a, b) => b.split("/").length - a.split("/").length),
    ),
  ];

  // interception routes should only be matched by a single entrypoint
  // we don't want to push a catch-all route to an interception route
  // because it would mean the interception would be handled by the wrong page component
  const filteredAppPaths = Object.keys(appPaths).filter(
    (route) => !isInterceptionRouteAppPath(route),
  );

  for (const appPath of filteredAppPaths) {
    for (const catchAllRoute of catchAllRoutes) {
      const normalizedCatchAllRoute = normalizer.normalize(catchAllRoute);
      const normalizedCatchAllRouteBasePath = normalizedCatchAllRoute.slice(
        0,
        normalizedCatchAllRoute.search(catchAllRouteRegex),
      );

      if (
        // check if the appPath could match the catch-all
        appPath.startsWith(normalizedCatchAllRouteBasePath) &&
        // check if there's not already a slot value that could match the catch-all
        !appPaths[appPath].some((path) => hasMatchedSlots(path, catchAllRoute))
      ) {
        // optional catch-all routes are not currently supported, but leaving this logic in place
        // for when they are eventually supported.
        if (isOptionalCatchAll(catchAllRoute)) {
          // optional catch-all routes should match both the root segment and any segment after it
          // for example, `/[[...slug]]` should match `/` and `/foo` and `/foo/bar`
          appPaths[appPath].push(catchAllRoute);
        } else if (isCatchAll(catchAllRoute)) {
          // regular catch-all (single bracket) should only match segments after it
          // for example, `/[...slug]` should match `/foo` and `/foo/bar` but not `/`
          if (normalizedCatchAllRouteBasePath !== appPath) {
            appPaths[appPath].push(catchAllRoute);
          }
        }
      }
    }
  }

  if (strictRouteMatching) {
    const topology = createParallelRouteTopology(appPaths, defaultAppPaths);
    pruneUnrenderableCatchAllRoutes(appPaths, topology);
    const incompatibleParallelRouteSlots = findIncompatibleParallelRouteSlotsWithTopology(
      appPaths,
      topology,
    );
    pruneUnrenderableRoutes(appPaths, topology);

    const matchedAppPaths = new Set(Object.values(appPaths).flat());
    return {
      unmatchedAppPages: [...pageAppPaths!]
        .filter((appPath) => !matchedAppPaths.has(appPath))
        .sort(),
      incompatibleParallelRouteSlots,
    };
  }

  return {
    unmatchedAppPages: [],
    incompatibleParallelRouteSlots: [],
  };
}

/**
 * Finds ordinary route matchers that cannot construct every slot owned by a
 * layout. Interception routes are partial updates and intentionally use
 * different matching semantics.
 */
export function findIncompatibleParallelRouteSlots(
  appPaths: Record<string, string[]>,
  defaultAppPaths: Iterable<string> = [],
): IncompatibleParallelRouteSlots[] {
  return findIncompatibleParallelRouteSlotsWithTopology(
    appPaths,
    createParallelRouteTopology(appPaths, defaultAppPaths),
  );
}

function findIncompatibleParallelRouteSlotsWithTopology(
  appPaths: Record<string, string[]>,
  { allAppPaths, levelsByParent }: ParallelRouteTopology,
): IncompatibleParallelRouteSlots[] {
  const incompatibleRoutes: IncompatibleParallelRouteSlots[] = [];

  for (const [route, matchedAppPaths] of Object.entries(appPaths)) {
    if (isBuiltin(route) || isInterceptionRouteAppPath(route)) continue;

    // Interception branches can be carried alongside an ordinary matcher, but
    // they retain state instead of satisfying a hard-navigation slot.
    const ordinaryAppPaths = matchedAppPaths.filter(
      (appPath) => isUserAppPageRoute(appPath) && !isInterceptionRouteAppPath(appPath),
    );
    if (ordinaryAppPaths.length === 0) continue;

    for (const { parentSegments, namedSlots, hasChildrenSlot } of levelsByParent.values()) {
      if (
        !ordinaryAppPaths.some((appPath) => hasPathPrefix(splitAppPath(appPath), parentSegments))
      ) {
        continue;
      }

      const siblingSlots = [...(hasChildrenSlot ? ["children"] : []), ...namedSlots];
      const missingSlots = siblingSlots.filter((slot) => {
        const hasMatchedPage = ordinaryAppPaths.some((appPath) =>
          isPathInSlot(appPath, parentSegments, slot),
        );
        const hasDefault = allAppPaths.has(getDefaultAppPath(parentSegments, slot));
        return !hasMatchedPage && !hasDefault;
      });

      if (missingSlots.length > 0) {
        incompatibleRoutes.push({
          layoutPath: `/${parentSegments.join("/")}`,
          route,
          missingSlots: missingSlots.sort(),
        });
      }
    }
  }

  return incompatibleRoutes.sort((a, b) =>
    a.layoutPath === b.layoutPath
      ? a.route.localeCompare(b.route)
      : a.layoutPath.localeCompare(b.layoutPath),
  );
}

function isBuiltin(appPath: string): boolean {
  return (
    appPath === UNDERSCORE_NOT_FOUND_ROUTE ||
    appPath === UNDERSCORE_NOT_FOUND_ROUTE_ENTRY ||
    appPath === UNDERSCORE_GLOBAL_ERROR_ROUTE ||
    appPath === UNDERSCORE_GLOBAL_ERROR_ROUTE_ENTRY
  );
}

/**
 * Removes catch-all-derived routes that can never render because another slot
 * at the same level has neither a matching page nor an explicit default.
 *
 * The built-in default for such a slot always calls `notFound()`. Keeping the
 * route in the matcher set would therefore retain a matcher that can never
 * construct a complete loader tree.
 */
function pruneUnrenderableCatchAllRoutes(
  appPaths: Record<string, string[]>,
  { allAppPaths, levelsByParent }: ParallelRouteTopology,
) {
  for (const [route, matchedAppPaths] of Object.entries(appPaths)) {
    const catchAllAppPaths = matchedAppPaths.filter(
      (appPath) => isUserAppPageRoute(appPath) && isCatchAll(appPath),
    );

    if (
      catchAllAppPaths.some((catchAllAppPath) => {
        const catchAllSegments = splitAppPath(catchAllAppPath).slice(0, -1);
        const interceptionMarkerIndex = catchAllSegments.findIndex((segment) =>
          INTERCEPTION_ROUTE_MARKERS.some((marker) => segment.startsWith(marker)),
        );

        for (const { parentSegments, namedSlots, hasChildrenSlot } of levelsByParent.values()) {
          if (!hasPathPrefix(catchAllSegments, parentSegments)) continue;

          const catchAllSlot = getSlotAtParent(catchAllSegments, parentSegments);
          const siblingSlots = [...(hasChildrenSlot ? ["children"] : []), ...namedSlots];
          // An interception response replaces one slot while retaining every
          // sibling owned by layouts up to the interception marker. Those
          // siblings use the null retain marker rather than a page or default.
          // Slots inside the newly selected subtree still match normally.
          const retainsInterceptionSiblings =
            interceptionMarkerIndex !== -1 && parentSegments.length <= interceptionMarkerIndex;

          for (const siblingSlot of siblingSlots) {
            if (siblingSlot === catchAllSlot) continue;

            const hasMatchedPage = matchedAppPaths.some((appPath) =>
              isPathInSlot(appPath, parentSegments, siblingSlot),
            );
            const hasDefault = allAppPaths.has(getDefaultAppPath(parentSegments, siblingSlot));

            if (!hasMatchedPage && !hasDefault && !retainsInterceptionSiblings) {
              return true;
            }
          }
        }

        return false;
      })
    ) {
      const nonPageAppPaths = matchedAppPaths.filter((appPath) => !isUserAppPageRoute(appPath));
      if (nonPageAppPaths.length === 0) {
        delete appPaths[route];
      } else {
        appPaths[route] = nonPageAppPaths;
      }
    }
  }
}

/**
 * Removes every route that cannot construct all slots at a matching layout
 * level. Catch-all-derived routes are removed by the earlier pass so the
 * caller can report only incompatible static matchers between the two passes.
 */
function pruneUnrenderableRoutes(
  appPaths: Record<string, string[]>,
  { allAppPaths, levelsByParent }: ParallelRouteTopology,
) {
  for (const [route, matchedAppPaths] of Object.entries(appPaths)) {
    const matchedPageAppPaths = matchedAppPaths.filter(isUserAppPageRoute);
    if (matchedPageAppPaths.length === 0) continue;

    if (hasIncompleteParallelRoute(matchedPageAppPaths, levelsByParent.values(), allAppPaths)) {
      const nonPageAppPaths = matchedAppPaths.filter((appPath) => !isUserAppPageRoute(appPath));
      if (nonPageAppPaths.length === 0) {
        delete appPaths[route];
      } else {
        appPaths[route] = nonPageAppPaths;
      }
    }
  }
}

function createParallelRouteTopology(
  appPaths: Record<string, string[]>,
  defaultAppPaths: Iterable<string>,
): ParallelRouteTopology {
  const allAppPaths = new Set([
    ...Object.entries(appPaths)
      .filter(([route]) => !isBuiltin(route))
      .flatMap(([, matchedAppPaths]) => matchedAppPaths)
      .filter(isUserAppPageRoute),
    ...[...defaultAppPaths].filter((appPath) => !isBuiltinAppPageEntry(appPath)),
  ]);

  return {
    allAppPaths,
    levelsByParent: collectParallelRouteLevels(allAppPaths),
  };
}

function collectParallelRouteLevels(
  allAppPaths: Iterable<string>,
): Map<string, ParallelRouteLevel> {
  const levelsByParent = new Map<string, ParallelRouteLevel>();

  for (const appPath of allAppPaths) {
    const segments = splitAppPath(appPath);

    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (!isMatchableSlot(segment)) continue;

      const parentSegments = segments.slice(0, i);
      const parentKey = JSON.stringify(parentSegments);
      let level = levelsByParent.get(parentKey);
      if (!level) {
        level = {
          parentSegments,
          namedSlots: new Set(),
          hasChildrenSlot: false,
        };
        levelsByParent.set(parentKey, level);
      }
      level.namedSlots.add(segment);
    }
  }

  for (const appPath of allAppPaths) {
    for (const level of levelsByParent.values()) {
      if (isPathInSlot(appPath, level.parentSegments, "children")) {
        level.hasChildrenSlot = true;
      }
    }
  }

  return levelsByParent;
}

function isUserAppPageRoute(appPath: string): boolean {
  return isAppPageRoute(appPath) && !isBuiltinAppPageEntry(appPath);
}

function isBuiltinAppPageEntry(appPath: string): boolean {
  return (
    appPath === UNDERSCORE_NOT_FOUND_ROUTE_ENTRY || appPath === UNDERSCORE_GLOBAL_ERROR_ROUTE_ENTRY
  );
}

function hasIncompleteParallelRoute(
  matchedAppPaths: string[],
  levels: Iterable<ParallelRouteLevel>,
  allAppPaths: Set<string>,
): boolean {
  const matchedSegments = matchedAppPaths.map((appPath) => splitAppPath(appPath).slice(0, -1));

  for (const { parentSegments, namedSlots, hasChildrenSlot } of levels) {
    const pathsAtLevel = matchedSegments.filter((segments) =>
      hasPathPrefix(segments, parentSegments),
    );
    if (pathsAtLevel.length === 0) continue;

    // An interception response replaces one slot while retaining every
    // sibling owned by layouts up to the interception marker. Those siblings
    // use the null retain marker rather than a page or default. Slots inside
    // the newly selected subtree still match normally.
    const retainsInterceptionSiblings = pathsAtLevel.some((segments) => {
      const interceptionMarkerIndex = segments.findIndex((segment) =>
        INTERCEPTION_ROUTE_MARKERS.some((marker) => segment.startsWith(marker)),
      );
      return interceptionMarkerIndex !== -1 && parentSegments.length <= interceptionMarkerIndex;
    });

    const slots = [...(hasChildrenSlot ? ["children"] : []), ...namedSlots];
    for (const slot of slots) {
      const hasMatchedPage = matchedAppPaths.some((appPath) =>
        isPathInSlot(appPath, parentSegments, slot),
      );
      const hasDefault = allAppPaths.has(getDefaultAppPath(parentSegments, slot));

      if (!hasMatchedPage && !hasDefault && !retainsInterceptionSiblings) {
        return true;
      }
    }
  }

  return false;
}

function splitAppPath(appPath: string): string[] {
  return appPath.split("/").filter(Boolean);
}

function hasPathPrefix(path: string[], prefix: string[]): boolean {
  return prefix.every((segment, index) => path[index] === segment);
}

function getSlotAtParent(path: string[], parent: string[]): string {
  const segment = path[parent.length];
  return segment?.startsWith("@") && segment !== "@children" ? segment : "children";
}

function isPathInSlot(appPath: string, parent: string[], slot: string): boolean {
  const segments = splitAppPath(appPath);
  return hasPathPrefix(segments, parent) && getSlotAtParent(segments, parent) === slot;
}

function getDefaultAppPath(parent: string[], slot: string): string {
  const segments = slot === "children" ? [...parent, "default"] : [...parent, slot, "default"];
  return `/${segments.join("/")}`;
}

function hasMatchedSlots(path1: string, path2: string): boolean {
  const slots1 = path1.split("/").filter(isMatchableSlot);
  const slots2 = path2.split("/").filter(isMatchableSlot);

  // if the catch-all route does not have the same number of slots as the app path, it can't match
  if (slots1.length !== slots2.length) return false;

  // compare the slots in both paths. For there to be a match, each slot must be the same
  for (let i = 0; i < slots1.length; i++) {
    if (slots1[i] !== slots2[i]) return false;
  }

  return true;
}

/**
 * Returns true for slots that should be considered when checking for match compatibility.
 * Excludes children slots because these are similar to having a segment-level `page`
 * which would cause a slot length mismatch when comparing it to a catch-all route.
 */
function isMatchableSlot(segment: string): boolean {
  return segment.startsWith("@") && segment !== "@children";
}

const catchAllRouteRegex = /\[?\[\.\.\./;

function isCatchAllRoute(pathname: string): boolean {
  // Optional catch-all slots are not currently supported, and as such they are not considered when checking for match compatability.
  return !isOptionalCatchAll(pathname) && isCatchAll(pathname);
}

function isOptionalCatchAll(pathname: string): boolean {
  return pathname.includes("[[...");
}

function isCatchAll(pathname: string): boolean {
  return pathname.includes("[...");
}

// --- shared/lib/errors

export class MissingCanonicalInterceptionRoutesError extends Error {
  constructor(routes: readonly MissingCanonicalInterceptionRoute[]) {
    const formattedRoutes = routes
      .map(
        ({ interceptionRoute, canonicalRoute }) =>
          `- ${interceptionRoute} (expected ${canonicalRoute})`,
      )
      .join("\n");
    super(
      `The following interception routes do not have a canonical route:\n${formattedRoutes}\n\nEvery interception route must have a matching non-interception route so the URL can be loaded directly or refreshed.`,
    );

    this.name = "MissingCanonicalInterceptionRoutesError";
    this.stack = undefined;
  }
}

export type IncompatibleParallelRouteSlotsWithLayoutFile = {
  layoutFile: string;
  route: string;
  missingSlots: readonly string[];
};

export class IncompatibleParallelRouteSlotsError extends Error {
  constructor(routes: readonly IncompatibleParallelRouteSlotsWithLayoutFile[]) {
    const routesByLayout = new Map<string, IncompatibleParallelRouteSlotsWithLayoutFile[]>();

    for (const route of routes) {
      const layoutRoutes = routesByLayout.get(route.layoutFile);
      if (layoutRoutes) {
        layoutRoutes.push(route);
      } else {
        routesByLayout.set(route.layoutFile, [route]);
      }
    }

    const formattedLayouts = [...routesByLayout]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([layoutFile, layoutRoutes]) => {
        const formattedRoutes = layoutRoutes
          .sort((a, b) => a.route.localeCompare(b.route))
          .map(
            ({ route, missingSlots }) =>
              `- ${route} is missing a matching page or default.tsx in ${missingSlots.join(", ")}`,
          )
          .join("\n");
        return `${layoutFile}\n${formattedRoutes}`;
      })
      .join("\n\n");

    super(
      `The following layouts have parallel route slots that cannot render the same URLs:\n${formattedLayouts}\n\nEvery URL matched by one slot must have a matching page or default.tsx in every sibling slot.`,
    );

    this.name = "IncompatibleParallelRouteSlotsError";
    this.stack = undefined;
  }
}

export class UnmatchedAppPagesError extends Error {
  constructor(pagePaths: readonly string[]) {
    const formattedPagePaths = pagePaths.map((pagePath) => `- ${pagePath}`).join("\n");
    super(
      `The following page files do not match any complete route:\n${formattedPagePaths}\n\nEvery page must be part of at least one complete route. Add matching pages or default files for the sibling parallel route slots, or remove the unreachable pages.`,
    );

    this.name = "UnmatchedAppPagesError";
    this.stack = undefined;
  }
}

// --- build/normalize-catchall-routes.ts: the build's signature, without a
// custom normalizer.
export function normalizeCatchAllRoutes(
  appPaths: Record<string, string[]>,
  options: NormalizeCatchAllRoutesOptions = {},
): NormalizeCatchAllRoutesResult {
  return normalizeCatchAllRoutesWithNormalizer(appPaths, undefined, options);
}
