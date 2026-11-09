export type AppRscRenderMode =
  | "navigation"
  | "prefetch-empty"
  | "prefetch-dynamic-shell"
  | "prefetch-loading-shell"
  | "prefetch-static-shell"
  | "prefetch-app-shell"
  | "prefetch-partial"
  | "prefetch-partial-navigation";

export const APP_RSC_RENDER_MODE_NAVIGATION = "navigation" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_EMPTY = "prefetch-empty" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL =
  "prefetch-dynamic-shell" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL =
  "prefetch-loading-shell" satisfies AppRscRenderMode;
/**
 * A Cache Components route's static shell: the page prerendered as Next.js
 * prefetches it, with its dynamic parts left at their Suspense fallbacks.
 */
export const APP_RSC_RENDER_MODE_PREFETCH_STATIC_SHELL =
  "prefetch-static-shell" satisfies AppRscRenderMode;
/**
 * A Partial Prefetching route's App Shell, which an automatic prefetch gets:
 * the static shell without what follows `prefetch()` or `navigation()`, or
 * caches that go stale within five minutes.
 */
export const APP_RSC_RENDER_MODE_PREFETCH_APP_SHELL =
  "prefetch-app-shell" satisfies AppRscRenderMode;
/**
 * A Partial Prefetching route's prefetch (`<Link prefetch={true}>`): the page
 * prerendered for the request, with its cached content and without its
 * dynamic data or what follows `navigation()`.
 */
export const APP_RSC_RENDER_MODE_PREFETCH_PARTIAL = "prefetch-partial" satisfies AppRscRenderMode;
/** The same, through the navigation stage (`<Link prefetch="navigation">`). */
export const APP_RSC_RENDER_MODE_PREFETCH_PARTIAL_NAVIGATION =
  "prefetch-partial-navigation" satisfies AppRscRenderMode;

/**
 * The prefetch stage a static-shell render mode asks for: `null` for the
 * static shell, which is the whole static prerender. `undefined` when the mode
 * isn't one.
 */
export function getStaticShellPrefetchStage(
  mode: AppRscRenderMode,
): "shell" | "prefetch" | "navigation" | null | undefined {
  switch (mode) {
    case APP_RSC_RENDER_MODE_PREFETCH_STATIC_SHELL:
      return null;
    case APP_RSC_RENDER_MODE_PREFETCH_APP_SHELL:
      return "shell";
    case APP_RSC_RENDER_MODE_PREFETCH_PARTIAL:
      return "prefetch";
    case APP_RSC_RENDER_MODE_PREFETCH_PARTIAL_NAVIGATION:
      return "navigation";
    case "navigation":
    case "prefetch-empty":
    case "prefetch-dynamic-shell":
    case "prefetch-loading-shell":
      return undefined;
    default:
      mode satisfies never;
      return undefined;
  }
}

/** The render mode a Cache Components shell prefetch to `stage` asks for. */
export function getStaticShellPrefetchRenderMode(
  stage: "shell" | "prefetch" | "navigation" | undefined,
): AppRscRenderMode {
  switch (stage) {
    case "shell":
      return APP_RSC_RENDER_MODE_PREFETCH_APP_SHELL;
    case "prefetch":
      return APP_RSC_RENDER_MODE_PREFETCH_PARTIAL;
    case "navigation":
      return APP_RSC_RENDER_MODE_PREFETCH_PARTIAL_NAVIGATION;
    case undefined:
      return APP_RSC_RENDER_MODE_PREFETCH_STATIC_SHELL;
    default:
      stage satisfies never;
      return APP_RSC_RENDER_MODE_PREFETCH_STATIC_SHELL;
  }
}

/** Whether the mode asks for a Cache Components shell: static, App Shell or partial. */
export function isStaticShellPrefetchRenderMode(mode: AppRscRenderMode | undefined): boolean {
  return mode !== undefined && getStaticShellPrefetchStage(mode) !== undefined;
}

/**
 * Marks a static-shell prefetch response: `partial` when the shell left some of
 * the page to its Suspense fallbacks, `complete` when it holds the whole page,
 * and `runtime` when the page's runtime prefetch rendered it for the request.
 */
export const VINEXT_STATIC_SHELL_HEADER = "X-Vinext-Static-Shell";
/**
 * The route params a static shell or runtime prefetch read, `?` for search
 * params, as a JSON array. A client reuses the payload for another URL of the
 * route with the same values for them, as Next.js's `varyParams` does.
 */
export const VINEXT_VARY_PARAMS_HEADER = "X-Vinext-Vary-Params";

export function getRscRenderModeCacheVariant(mode: AppRscRenderMode): string | null {
  if (mode === APP_RSC_RENDER_MODE_PREFETCH_EMPTY) {
    return "prefetch-empty";
  }

  if (mode === APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL) {
    return "prefetch-dynamic-shell";
  }
  if (mode === APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL) {
    return "prefetch-loading-shell";
  }
  if (isStaticShellPrefetchRenderMode(mode)) {
    return mode;
  }

  return null;
}

export function parseAppRscRenderMode(value: string | null): AppRscRenderMode {
  switch (value) {
    case APP_RSC_RENDER_MODE_PREFETCH_EMPTY:
      return APP_RSC_RENDER_MODE_PREFETCH_EMPTY;
    case APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL:
      return APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL;
    case APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL:
      return APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL;
    case APP_RSC_RENDER_MODE_PREFETCH_STATIC_SHELL:
      return APP_RSC_RENDER_MODE_PREFETCH_STATIC_SHELL;
    case APP_RSC_RENDER_MODE_PREFETCH_APP_SHELL:
      return APP_RSC_RENDER_MODE_PREFETCH_APP_SHELL;
    case APP_RSC_RENDER_MODE_PREFETCH_PARTIAL:
      return APP_RSC_RENDER_MODE_PREFETCH_PARTIAL;
    case APP_RSC_RENDER_MODE_PREFETCH_PARTIAL_NAVIGATION:
      return APP_RSC_RENDER_MODE_PREFETCH_PARTIAL_NAVIGATION;
    case null:
    default:
      return APP_RSC_RENDER_MODE_NAVIGATION;
  }
}
