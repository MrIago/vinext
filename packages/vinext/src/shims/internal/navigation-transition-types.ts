import * as React from "react";

/**
 * Register a navigation's View Transition types on the transition that is
 * running, as Next.js does inside the navigation's `startTransition`
 * (sequential-router-queue.ts): `<ViewTransition>` boundaries then pick the
 * class for each type (`::view-transition-old(.slide)`). vinext's navigation
 * stays one async transition until its payload commits, so types registered
 * here apply to the commit. React 19.3 made `addTransitionType` stable; with an
 * older React the call is skipped.
 */
export function addNavigationTransitionTypes(transitionTypes: readonly string[] | undefined): void {
  if (!transitionTypes || transitionTypes.length === 0) return;
  const addTransitionType = (React as { addTransitionType?: (type: string) => void })
    .addTransitionType;
  if (typeof addTransitionType !== "function") return;
  for (const type of transitionTypes) addTransitionType(type);
}
