import { inspect } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import {
  headers,
  headersContextFromRequest,
  runWithHeadersContext,
} from "../packages/vinext/src/shims/headers.js";
import { sealRequestHeaders } from "../packages/vinext/src/shims/server.js";

// Node prints a promise's AsyncLocalStorage store when it inspects the
// promise, so `console.log(new Promise(() => {}))` in app code walks every
// object in vinext's request context. A Proxy over a Headers instance used to
// throw `Cannot read private member #headersList` there, which aborted module
// evaluation and turned every page into a 500.
describe("request headers are safe to util.inspect", () => {
  it("inspects the request headers context and the sealed headers() view", async () => {
    const ctx = headersContextFromRequest(
      new Request("http://localhost/", { headers: { "x-test": "1" } }),
    );

    await runWithHeadersContext(ctx, async () => {
      const readonly = headers();
      expect(inspect(readonly)).toContain("x-test");
      expect(inspect(ctx.headers)).toContain("x-test");
      expect(() => inspect(new Promise(() => {}), { depth: 10 })).not.toThrow();
    });
  });

  it("inspects the sealed route handler request headers", () => {
    const sealed = sealRequestHeaders(new Headers({ "x-route": "1" }));
    expect(inspect(sealed)).toContain("x-route");
    expect(sealed).toBeInstanceOf(Headers);
  });

  it("inspects the lazy headers proxy after its first write", () => {
    const ctx = headersContextFromRequest(new Request("http://localhost/"));
    ctx.headers.set("x-written", "1");
    expect(inspect(ctx.headers)).toContain("x-written");
  });
});
