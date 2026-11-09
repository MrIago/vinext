import { describe, expect, it } from "vitest";
import type { AppRouterState } from "../packages/vinext/src/server/app-browser-state.js";
import { isSupersededByHistoryRestore } from "../packages/vinext/src/server/app-browser-visible-commit.js";

// Regression for https://github.com/cloudflare/vinext/issues/3013: Back pressed
// right after a navigation became visible restores the previous entry, and the
// navigation's queued transition must not apply its state on top of it.
function state(
  visibleCommitVersion: number,
  activeOperation: AppRouterState["activeOperation"],
): AppRouterState {
  return { activeOperation, visibleCommitVersion } as AppRouterState;
}

const committed = (lane: "navigation" | "traverse", startedVisibleCommitVersion: number) => ({
  id: 1,
  lane,
  startedVisibleCommitVersion,
  state: "committed" as const,
  visibleCommitVersion: startedVisibleCommitVersion + 1,
});

describe("isSupersededByHistoryRestore", () => {
  it("drops a navigation started before a history restore committed", () => {
    const restored = state(2, committed("traverse", 1));
    const queuedNavigation = state(2, committed("navigation", 1));
    expect(isSupersededByHistoryRestore(restored, queuedNavigation)).toBe(true);
  });

  it("applies a navigation started from the restored tree", () => {
    const restored = state(2, committed("traverse", 1));
    const nextNavigation = state(3, committed("navigation", 2));
    expect(isSupersededByHistoryRestore(restored, nextNavigation)).toBe(false);
  });

  it("applies a navigation when no restore happened", () => {
    const visible = state(1, committed("navigation", 0));
    const nextNavigation = state(2, committed("navigation", 1));
    expect(isSupersededByHistoryRestore(visible, nextNavigation)).toBe(false);
  });

  it("never drops a later traversal", () => {
    const restored = state(2, committed("traverse", 1));
    const laterTraversal = state(2, committed("traverse", 1));
    expect(isSupersededByHistoryRestore(restored, laterTraversal)).toBe(false);
  });
});
