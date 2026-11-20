import { describe, expect, it } from "vitest";
import { getExperimentalReactFlags } from "../packages/vinext/src/config/next-config.js";

// Ported from Next.js: packages/next/src/lib/needs-experimental-react.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/needs-experimental-react.ts
// (#2109 useExperimentalReact, #4390 hydrationChangeEvent)
describe("getExperimentalReactFlags", () => {
  it("lists the enabled flags that need React's experimental channel", () => {
    expect(
      getExperimentalReactFlags({ hydrationChangeEvent: true, taint: false, ppr: true }),
    ).toEqual(["hydrationChangeEvent"]);
    expect(getExperimentalReactFlags({ useExperimentalReact: true })).toEqual([
      "useExperimentalReact",
    ]);
  });

  it("is empty without experimental config", () => {
    expect(getExperimentalReactFlags(undefined)).toEqual([]);
    expect(getExperimentalReactFlags({})).toEqual([]);
  });
});
