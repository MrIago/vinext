/**
 * Compatibility-date guard for Cloudflare Workers projects.
 *
 * React's flight client (used by every App Router RSC response) calls
 * `new WeakRef(...)`. workerd only exposes the global `WeakRef` from
 * compatibility_date 2025-05-05, or with the `enable_weak_ref` flag. With an
 * older date every App Router request fails with
 * "ReferenceError: WeakRef is not defined", and nothing points at the config.
 * https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-finalizationregistry-and-weakref
 */

import fs from "node:fs";
import path from "pathslash";

export const WEAKREF_COMPAT_DATE = "2025-05-05";

export type WranglerCompatibility = {
  compatibilityDate?: string;
  compatibilityFlags?: string[];
};

const WRANGLER_FILES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"] as const;

/** Find the root-level Wrangler config file the Cloudflare plugin would pick up. */
export function findWranglerConfigFile(root: string): string | undefined {
  return WRANGLER_FILES.find((name) => fs.existsSync(path.join(root, name)));
}

/**
 * Read compatibility_date / compatibility_flags from wrangler.{jsonc,json,toml}.
 * Only these two top-level keys are needed, so this avoids a full JSONC/TOML
 * parser: plain JSON goes through JSON.parse, everything else through
 * line-anchored matches, which also skips commented-out lines.
 */
export function readWranglerCompatibility(root: string): WranglerCompatibility | null {
  const file = findWranglerConfigFile(root);
  if (!file) return null;
  const content = fs.readFileSync(path.join(root, file), "utf-8");

  if (file !== "wrangler.toml") {
    try {
      const json: unknown = JSON.parse(content);
      if (json && typeof json === "object") {
        const config = json as Record<string, unknown>;
        return {
          compatibilityDate:
            typeof config.compatibility_date === "string" ? config.compatibility_date : undefined,
          compatibilityFlags: Array.isArray(config.compatibility_flags)
            ? config.compatibility_flags.filter((f): f is string => typeof f === "string")
            : undefined,
        };
      }
    } catch {
      // JSONC (comments / trailing commas): fall through to the line matcher.
    }
  }

  // JSON keys are quoted, TOML keys are bare and use `=`.
  const key = (name: string) => `^[ \\t]*"?${name}"?[ \\t]*[:=][ \\t]*`;
  const dateMatch = content.match(new RegExp(`${key("compatibility_date")}["']([^"']+)["']`, "m"));
  const flagsMatch = content.match(new RegExp(`${key("compatibility_flags")}\\[([^\\]]*)\\]`, "m"));
  return {
    compatibilityDate: dateMatch?.[1],
    compatibilityFlags: flagsMatch
      ? // Drop `//` (JSONC) and `#` (TOML) line comments inside the array first.
        [...flagsMatch[1].replace(/(?:\/\/|#)[^\n]*/g, "").matchAll(/["']([^"']+)["']/g)].map(
          (m) => m[1],
        )
      : undefined,
  };
}

/**
 * Build the warning shown when the compatibility settings leave `WeakRef`
 * undefined in workerd. Returns null when they're fine or the date can't be
 * interpreted.
 */
export function formatWeakRefCompatWarning(
  config: WranglerCompatibility,
  configFile = "your Wrangler config",
): string | null {
  const date = config.compatibilityDate;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  // ISO dates compare correctly as strings.
  if (date >= WEAKREF_COMPAT_DATE) return null;
  if (config.compatibilityFlags?.includes("enable_weak_ref")) return null;
  return (
    `[vinext] compatibility_date "${date}" in ${configFile} is older than ${WEAKREF_COMPAT_DATE}.\n` +
    `  workerd only exposes WeakRef from ${WEAKREF_COMPAT_DATE}, and React Server Components\n` +
    `  need it: App Router requests will fail with "ReferenceError: WeakRef is not defined".\n` +
    `  Fix: set "compatibility_date" to "${WEAKREF_COMPAT_DATE}" or later,\n` +
    `  or add "enable_weak_ref" to "compatibility_flags".`
  );
}
