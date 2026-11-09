import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createInjectedInstrumentationModule } from "../packages/vinext/src/index.js";

// Ported from Next.js `instrumentationInject` (vercel/next.js#100658):
// injected modules run before the project's instrumentation file, register()
// in order, and each onRequestError() independently.
describe("createInjectedInstrumentationModule", () => {
  it("is null when nothing is injected", () => {
    expect(createInjectedInstrumentationModule([], "/app/instrumentation.ts")).toBeNull();
  });

  it("imports the injected modules before the project's instrumentation", () => {
    const code = createInjectedInstrumentationModule(
      ["@adapter/tracing", "/app/adapters/errors.ts"],
      "/app/instrumentation.ts",
    )!;
    const order = ["@adapter/tracing", "/app/adapters/errors.ts", "/app/instrumentation.ts"].map(
      (source) => code.indexOf(JSON.stringify(source)),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("runs register() in order and isolates onRequestError() failures", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-injected-instrumentation-"));
    try {
      fs.writeFileSync(
        path.join(dir, "a.mjs"),
        `export async function register() { globalThis.__calls.push("register a"); }
export async function onRequestError() { throw new Error("a failed"); }`,
      );
      fs.writeFileSync(
        path.join(dir, "b.mjs"),
        `export async function register() { globalThis.__calls.push("register b"); }
export async function onRequestError() { globalThis.__calls.push("error b"); }`,
      );
      const code = createInjectedInstrumentationModule(
        [path.join(dir, "a.mjs"), path.join(dir, "b.mjs")],
        null,
      )!;
      const compositePath = path.join(dir, "composite.mjs");
      fs.writeFileSync(compositePath, code);
      const calls: string[] = [];
      (globalThis as { __calls?: string[] }).__calls = calls;
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const composite = await import(pathToFileURL(compositePath).href);
      await composite.register();
      await composite.onRequestError();
      error.mockRestore();
      expect(calls).toEqual(["register a", "register b", "error b"]);
    } finally {
      delete (globalThis as { __calls?: string[] }).__calls;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
