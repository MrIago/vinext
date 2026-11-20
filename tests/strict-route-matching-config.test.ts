import { describe, expect, it } from "vitest";
import { resolveStrictRouteMatching } from "../packages/vinext/src/config/next-config.js";

// Ported from Next.js server/config.ts and config-schema.ts (vercel/next.js#97397):
// strict route matching is the default, `deprecated.looseRouteMatching: true`
// restores loose matching, and the legacy implicit children slot turns it off.
describe("resolveStrictRouteMatching", () => {
  it("is strict by default", () => {
    expect(resolveStrictRouteMatching({}, undefined)).toEqual({
      explicitParallelRouteChildren: true,
      strictRouteMatching: true,
    });
  });

  it("turns off with deprecated.looseRouteMatching", () => {
    expect(
      resolveStrictRouteMatching({ deprecated: { looseRouteMatching: true } }, undefined)
        .strictRouteMatching,
    ).toBe(false);
  });

  it("turns off with the legacy implicit children slot", () => {
    expect(resolveStrictRouteMatching({}, { explicitParallelRouteChildren: false })).toEqual({
      explicitParallelRouteChildren: false,
      strictRouteMatching: false,
    });
  });

  it("accepts only true for looseRouteMatching", () => {
    expect(() =>
      resolveStrictRouteMatching(
        { deprecated: { looseRouteMatching: false as unknown as true } },
        undefined,
      ),
    ).toThrow(/expected `true`/);
  });
});
