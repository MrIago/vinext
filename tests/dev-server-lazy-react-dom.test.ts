import { describe, expect, it, vi } from "vite-plus/test";

// React below 19.3 has no named `renderToReadableStream` export in the Node
// build of react-dom/server. vite.config.ts imports vinext, which reaches the
// dev server module, so an eager import fails while loading the config, before
// the build's React version check can explain the problem.
vi.mock("react-dom/server", () => {
  throw new Error("react-dom/server must not load with the vinext plugin");
});

describe("dev server react-dom/server import", () => {
  it("does not load react-dom/server when the module is imported", async () => {
    await expect(import("../packages/vinext/src/server/dev-server.js")).resolves.toHaveProperty(
      "createSSRHandler",
    );
  });
});
