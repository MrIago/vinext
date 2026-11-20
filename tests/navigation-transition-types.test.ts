import { describe, expect, it, vi } from "vitest";

const addTransitionType = vi.fn();
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  addTransitionType,
}));

// https://github.com/cloudflare/vinext/issues/2603: like Next.js
// (sequential-router-queue.ts), a navigation registers its Link or
// router.push/replace `transitionTypes` on the transition it runs in.
describe("addNavigationTransitionTypes", () => {
  it("registers each type with React", async () => {
    const { addNavigationTransitionTypes } =
      await import("../packages/vinext/src/shims/internal/navigation-transition-types.js");
    addNavigationTransitionTypes(["slide", "fade"]);
    expect(addTransitionType.mock.calls).toEqual([["slide"], ["fade"]]);
  });

  it("does nothing without types", async () => {
    addTransitionType.mockClear();
    const { addNavigationTransitionTypes } =
      await import("../packages/vinext/src/shims/internal/navigation-transition-types.js");
    addNavigationTransitionTypes(undefined);
    addNavigationTransitionTypes([]);
    expect(addTransitionType).not.toHaveBeenCalled();
  });
});
