// React's flight client calls `new WeakRef(...)`. workerd only exposes
// WeakRef from compatibility_date 2025-05-05 (or with `enable_weak_ref`), so
// an older date makes every App Router request 500 under the Cloudflare
// plugin. (#1315)
import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatWeakRefCompatWarning,
  readWranglerCompatibility,
} from "../packages/vinext/src/utils/wrangler-compat.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-wrangler-compat-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string) {
  fs.writeFileSync(path.join(tmpDir, name), content);
}

describe("readWranglerCompatibility", () => {
  it("reads plain single-line JSON", () => {
    write(
      "wrangler.jsonc",
      '{"name":"r","compatibility_date":"2025-01-01","compatibility_flags":["nodejs_compat"]}',
    );
    expect(readWranglerCompatibility(tmpDir)).toEqual({
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"],
    });
  });

  it("reads JSONC and ignores commented-out settings", () => {
    write(
      "wrangler.jsonc",
      `{
  // "compatibility_date": "2020-01-01",
  "compatibility_date": "2025-01-01", // pinned
  "compatibility_flags": [
    "nodejs_compat",
    "enable_weak_ref",
  ],
}`,
    );
    expect(readWranglerCompatibility(tmpDir)).toEqual({
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat", "enable_weak_ref"],
    });
  });

  it("reads TOML", () => {
    write(
      "wrangler.toml",
      `name = "app"\ncompatibility_date = "2024-09-23"\ncompatibility_flags = [ "nodejs_compat", 'enable_weak_ref' ]\n`,
    );
    expect(readWranglerCompatibility(tmpDir)).toEqual({
      compatibilityDate: "2024-09-23",
      compatibilityFlags: ["nodejs_compat", "enable_weak_ref"],
    });
  });

  it("returns null without a wrangler config", () => {
    expect(readWranglerCompatibility(tmpDir)).toBeNull();
  });
});

describe("formatWeakRefCompatWarning", () => {
  it("warns when compatibility_date is before 2025-05-05", () => {
    const msg = formatWeakRefCompatWarning(
      { compatibilityDate: "2025-05-04", compatibilityFlags: ["nodejs_compat"] },
      "wrangler.jsonc",
    );
    expect(msg).toContain('"2025-05-04"');
    expect(msg).toContain("2025-05-05");
    expect(msg).toContain("enable_weak_ref");
    expect(msg).toContain("WeakRef is not defined");
    expect(msg).toContain("wrangler.jsonc");
  });

  it("does not warn on 2025-05-05 or later", () => {
    expect(formatWeakRefCompatWarning({ compatibilityDate: "2025-05-05" })).toBeNull();
    expect(formatWeakRefCompatWarning({ compatibilityDate: "2026-02-12" })).toBeNull();
  });

  it("does not warn when enable_weak_ref is set", () => {
    expect(
      formatWeakRefCompatWarning({
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat", "enable_weak_ref"],
      }),
    ).toBeNull();
  });

  it("does not warn when compatibility_date is missing or unparseable", () => {
    expect(formatWeakRefCompatWarning({})).toBeNull();
    expect(formatWeakRefCompatWarning({ compatibilityDate: "latest" })).toBeNull();
  });
});
