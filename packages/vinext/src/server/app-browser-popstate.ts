import {
  isExternalHistoryState,
  readHistoryStateTraversalIndex,
  type HistoryTraversalIntent,
} from "./app-browser-state.js";
import type { NavigationRuntimeNavigate } from "../client/navigation-runtime.js";

type RestoreScrollPosition = (
  state: unknown,
  options?: {
    shouldContinue?: () => boolean;
  },
) => void;

type BrowserPopstateRestoreDeps = {
  getActiveNavigationId: () => number;
  getPendingNavigation: () => Promise<void> | null | undefined;
  getNavigate: () => NavigationRuntimeNavigate | undefined;
  isCurrentNavigation: (navId: number) => boolean;
  notifyAppRouterTransitionStart: (href: string) => void;
  restorePopstateScrollPosition: RestoreScrollPosition;
  setPendingNavigation: (pendingNavigation: Promise<void> | null) => void;
  shouldSkipScrollRestore: (navId: number) => boolean;
};

type SynchronousPopstateScrollRestoreDeps = {
  getActiveNavigationId: () => number;
  isCurrentNavigation: (navId: number) => boolean;
  markScrollRestoreConsumed: (navId: number) => void;
  restorePopstateScrollPosition: RestoreScrollPosition;
};

function hasSavedScrollPosition(state: unknown): boolean {
  return Boolean(state && typeof state === "object" && "__vinext_scrollY" in state);
}

export function restoreSynchronousPopstateScrollPosition(
  deps: SynchronousPopstateScrollRestoreDeps,
  state: unknown,
): void {
  const navId = deps.getActiveNavigationId();
  deps.markScrollRestoreConsumed(navId);
  deps.restorePopstateScrollPosition(state, {
    shouldContinue: () => deps.isCurrentNavigation(navId),
  });
}

function scheduleAfterFrame(callback: () => void): void {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(callback);
    return;
  }

  queueMicrotask(callback);
}

function createPopstateTraversalIntent(historyState: unknown): HistoryTraversalIntent {
  return {
    direction: "unknown",
    historyState,
    targetHistoryIndex: readHistoryStateTraversalIndex(historyState),
  };
}

export function shouldCommitPopstateUrlWithoutNavigation(options: {
  historyState: unknown;
  isCurrentExternalHistoryTree: boolean;
  isSameAppRouteTarget: boolean;
}): boolean {
  if (isExternalHistoryState(options.historyState)) {
    return options.isCurrentExternalHistoryTree;
  }
  return options.isSameAppRouteTarget;
}

export function createPopstateRestoreHandler(
  deps: BrowserPopstateRestoreDeps,
): (event: PopStateEvent) => void {
  return (event) => {
    deps.notifyAppRouterTransitionStart(window.location.href);
    const navigate = deps.getNavigate();
    const pendingNavigation =
      navigate?.(
        window.location.href,
        0,
        "traverse",
        undefined,
        undefined,
        false,
        createPopstateTraversalIntent(event.state),
      ) ?? Promise.resolve();
    const popstateNavId = deps.getActiveNavigationId();

    deps.setPendingNavigation(pendingNavigation);
    const shouldRestoreSavedScroll = hasSavedScrollPosition(event.state);
    const shouldRestoreScrollForNavigation = () =>
      deps.isCurrentNavigation(popstateNavId) && !deps.shouldSkipScrollRestore(popstateNavId);

    if (shouldRestoreSavedScroll) {
      scheduleAfterFrame(() => {
        if (shouldRestoreScrollForNavigation()) {
          deps.restorePopstateScrollPosition(event.state, {
            shouldContinue: shouldRestoreScrollForNavigation,
          });
        }
      });
    }

    void pendingNavigation.finally(() => {
      if (shouldRestoreScrollForNavigation() && !shouldRestoreSavedScroll) {
        deps.restorePopstateScrollPosition(event.state);
      }

      if (deps.getPendingNavigation() === pendingNavigation) {
        deps.setPendingNavigation(null);
      }
    });
  };
}

type MissedTraversalWindow = {
  history: { state: unknown };
  navigation?: {
    activation?: { entry?: { key?: string } | null } | null;
    currentEntry?: { key?: string } | null;
  };
};

/**
 * A Back/Forward pressed before the App Router installs its popstate listener
 * moves the document to another history entry while nobody listens, and the
 * traversal is lost. The Navigation API keeps the entry the document was
 * activated on, and entry keys survive replaceState, so a different current
 * entry means a traversal went unobserved. Only entries this router wrote can
 * be restored; the caller replays the traversal with the returned state.
 *
 * Mirrors `hasMissedTraversal` in Next.js's app-router.tsx (vercel/next.js#96252).
 */
export function readMissedTraversalState(win: MissedTraversalWindow): { state: unknown } | null {
  const activationKey = win.navigation?.activation?.entry?.key;
  const currentKey = win.navigation?.currentEntry?.key;
  if (activationKey === undefined || currentKey === undefined || activationKey === currentKey) {
    return null;
  }
  const state = win.history.state;
  if (state === null || typeof state !== "object") return null;
  if (!Object.keys(state).some((key) => key.startsWith("__vinext"))) return null;
  return { state };
}
