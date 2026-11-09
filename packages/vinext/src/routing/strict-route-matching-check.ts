import fs from "node:fs";
import path from "pathslash";
import type { ValidFileMatcher } from "./file-matcher.js";
import {
  findMissingCanonicalInterceptionRoutes,
  IncompatibleParallelRouteSlotsError,
  isAppPageRoute,
  MissingCanonicalInterceptionRoutesError,
  normalizeAppPath,
  normalizeCatchAllRoutes,
  UnmatchedAppPagesError,
} from "./strict-route-matching.js";

/**
 * The warning Next.js prints with any strict route matching error while strict
 * matching is the default.
 * Ported from Next.js: packages/next/src/server/lib/router-utils/strict-route-matching-config.ts
 */
export const STRICT_ROUTE_MATCHING_DEFAULT_WARNING =
  "Strict route matching is enabled by default. This validation indicates a bug in your app's route structure, but you can temporarily restore loose route matching by setting `deprecated.looseRouteMatching` to `true` in your Next.js config.";

type AppStructure = {
  /** Next.js's `appPaths` for pages: route pathname → app paths. */
  appPagePaths: Record<string, string[]>;
  /** `default` app paths, such as `/@modal/default`. */
  defaultAppPaths: string[];
  /** App path → absolute file, for messages. */
  appPageFiles: Map<string, string>;
  /** Layout path (`/dashboard`) → absolute layout file, for messages. */
  layoutFiles: Map<string, string>;
};

/**
 * Collect the app directory as Next.js's entry discovery does: every `page`,
 * `default` and `layout` file, by its app path (filesystem segments with
 * route groups and `@slots`, ending in the file name). Private folders
 * (`_name`) are not routable and are skipped.
 */
export function collectAppStructure(appDir: string, matcher: ValidFileMatcher): AppStructure {
  const structure: AppStructure = {
    appPagePaths: {},
    defaultAppPaths: [],
    appPageFiles: new Map(),
    layoutFiles: new Map(),
  };

  const walk = (dir: string, segments: string[]): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith("_") || entry.name === "node_modules") continue;
        walk(filePath, [...segments, entry.name]);
        continue;
      }
      if (!entry.isFile() || !matcher.isPageFile(entry.name)) continue;
      const leaf = matcher.stripExtension(entry.name);
      const appPath = `/${[...segments, leaf].join("/")}`;
      if (leaf === "page") {
        const route = normalizeAppPath(appPath);
        (structure.appPagePaths[route] ??= []).push(appPath);
        structure.appPageFiles.set(appPath, filePath);
      } else if (leaf === "default") {
        structure.defaultAppPaths.push(appPath);
      } else if (leaf === "layout") {
        structure.layoutFiles.set(`/${segments.join("/")}`, filePath);
      }
    }
  };
  walk(appDir, []);
  return structure;
}

/**
 * The route matching errors Next.js reports for an app under strict route
 * matching, in its order: interception routes without a canonical route,
 * incompatible parallel-route slots, then unmatched pages.
 *
 * Mirrors the strict route matching block of Next.js's
 * packages/next/src/build/entries.ts and server/lib/router-utils/setup-dev-bundler.ts.
 */
export function findStrictRouteMatchingErrors(options: {
  appDir: string;
  root: string;
  matcher: ValidFileMatcher;
}): Error[] {
  const { appPagePaths, defaultAppPaths, appPageFiles, layoutFiles } = collectAppStructure(
    options.appDir,
    options.matcher,
  );
  const { unmatchedAppPages, incompatibleParallelRouteSlots } = normalizeCatchAllRoutes(
    appPagePaths,
    { strictRouteMatching: true, defaultAppPaths },
  );
  // Only App Router pages make an intercepted URL directly renderable.
  const pagePathsPerRoute = Object.fromEntries(
    Object.entries(appPagePaths).flatMap(([route, appPaths]) => {
      const pageAppPaths = appPaths.filter(isAppPageRoute);
      return pageAppPaths.length > 0 ? [[route, pageAppPaths]] : [];
    }),
  );
  const missingCanonicalInterceptionRoutes =
    findMissingCanonicalInterceptionRoutes(pagePathsPerRoute);

  const errors: Error[] = [];
  if (missingCanonicalInterceptionRoutes.length > 0) {
    errors.push(new MissingCanonicalInterceptionRoutesError(missingCanonicalInterceptionRoutes));
  }
  if (incompatibleParallelRouteSlots.length > 0) {
    errors.push(
      new IncompatibleParallelRouteSlotsError(
        incompatibleParallelRouteSlots.map((incompatibleRoute) => ({
          ...incompatibleRoute,
          layoutFile: path.relative(
            options.root,
            layoutFiles.get(incompatibleRoute.layoutPath) ??
              path.join(options.appDir, incompatibleRoute.layoutPath, "layout"),
          ),
        })),
      ),
    );
  }
  if (unmatchedAppPages.length > 0) {
    errors.push(
      new UnmatchedAppPagesError(
        unmatchedAppPages.map((appPath) => {
          const filePath = appPageFiles.get(appPath);
          return filePath ? path.relative(options.root, filePath) : appPath;
        }),
      ),
    );
  }
  return errors;
}

/** One error from several, joined like Next.js's build does. */
export function combineStrictRouteMatchingErrors(errors: readonly Error[]): Error | null {
  if (errors.length === 0) return null;
  if (errors.length === 1) return errors[0]!;
  return new Error(errors.map((error) => error.message).join("\n\n"));
}
