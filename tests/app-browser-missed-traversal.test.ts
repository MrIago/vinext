import { describe, expect, it } from "vitest";
import { readMissedTraversalState } from "../packages/vinext/src/server/app-browser-popstate.js";

// Ported from Next.js: replay a Back/Forward pressed before the App Router's
// popstate listener is installed (vercel/next.js#96252, app-router.tsx
// `hasMissedTraversal`).
// https://github.com/vercel/next.js/pull/96252
describe("readMissedTraversalState", () => {
  const routerState = { __vinext_treeSnapshotId: 1 };

  it("returns the current entry's state when the document moved off its activation entry", () => {
    expect(
      readMissedTraversalState({
        history: { state: routerState },
        navigation: { activation: { entry: { key: "a" } }, currentEntry: { key: "b" } },
      }),
    ).toEqual({ state: routerState });
  });

  it("ignores a document still on the entry it was activated on", () => {
    expect(
      readMissedTraversalState({
        history: { state: routerState },
        navigation: { activation: { entry: { key: "a" } }, currentEntry: { key: "a" } },
      }),
    ).toBeNull();
  });

  it("ignores browsers without the Navigation API", () => {
    expect(readMissedTraversalState({ history: { state: routerState } })).toBeNull();
  });

  it("leaves entries the App Router did not write alone", () => {
    expect(
      readMissedTraversalState({
        history: { state: { fromPagesRouter: true } },
        navigation: { activation: { entry: { key: "a" } }, currentEntry: { key: "b" } },
      }),
    ).toBeNull();
    expect(
      readMissedTraversalState({
        history: { state: null },
        navigation: { activation: { entry: { key: "a" } }, currentEntry: { key: "b" } },
      }),
    ).toBeNull();
  });
});
