import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

// vite.config.ts imports vinext, which reaches the dev server module, so it
// links while Vite loads the config. React below 19.3 has no named
// `renderToReadableStream` in the Node build of react-dom/server, and a named
// import there fails with a bare SyntaxError before the build's React version
// check runs. Vitest rewrites imports, so it can't reproduce the link error;
// guard the import shape instead.
describe("dev server react-dom/server import", () => {
  it("imports react-dom/server by its default export only", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../packages/vinext/src/server/dev-server.ts"),
      "utf-8",
    );
    const imports = source.match(/^import\s[^;]*?from\s+"react-dom\/server";/gm) ?? [];
    expect(imports).toEqual(['import ReactDOMServer from "react-dom/server";']);
  });
});
