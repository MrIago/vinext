/**
 * vinext font plugins
 *
 * Exports two Vite plugins:
 *
 * `createGoogleFontsPlugin` — vinext:google-fonts
 *   1. Rewrites named `next/font/google` imports/exports to tiny virtual modules
 *      that export only the requested fonts plus any utility exports. This lets us
 *      delete the generated ~1,900-line runtime catalog while keeping ESM import
 *      semantics intact.
 *   2. During production builds, fetches Google Fonts CSS + font files, caches
 *      them locally under `.vinext/fonts/`, and injects `_vinext.font` into
 *      statically analyzable font loader calls so fonts are served from the
 *      deployed origin rather than fonts.googleapis.com. Static calls also
 *      receive adjusted fallback CSS when Next.js-compatible fallback metrics
 *      exist for the selected Google Font.
 *
 * `createLocalFontsPlugin` — vinext:local-fonts
 *   When a source file calls localFont({ src: "./font.woff2" }) or
 *   localFont({ src: [{ path: "./font.woff2" }] }), the relative paths
 *   won't resolve in the browser because the CSS is injected at runtime.
 *   This plugin rewrites those path strings into Vite asset import references
 *   so that both dev (/@fs/...) and prod (/assets/font-xxx.woff2) URLs are
 *   correct.
 */

import type { ESTree, Plugin } from "vite";
import {
  getAstName,
  LEADING_TRIVIA_RE,
  parseProgram,
  scriptParserLanguage,
  walkAst,
} from "./ast-utils.js";
import path, { toSlash } from "pathslash";
import fs from "node:fs";
import MagicString from "magic-string";
import { magicStringTransformResult } from "./transform-result.js";
import {
  buildFallbackFontFace,
  getFallbackFontOverrideMetrics,
} from "../build/google-fonts/fallback-metrics.js";
import { validateGoogleFontOptions } from "../build/google-fonts/validate.js";
import { getFontAxes } from "../build/google-fonts/get-axes.js";
import { buildGoogleFontsUrl } from "../build/google-fonts/build-url.js";
import { findFontFilesInCss } from "../build/google-fonts/find-font-files-in-css.js";
import { CONTENT_TYPES } from "../server/static-file-cache.js";
import { ASSET_PREFIX_URL_DIR } from "../utils/asset-prefix.js";

/**
 * Thrown when Google Fonts returns a non-2xx response. Distinct from a raw
 * `fetch` rejection (network error, DNS failure, AbortError) so the call
 * site can decide whether to surface as a build error or fall through to
 * the runtime CDN path.
 */
class GoogleFontsHttpError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(`Google Fonts returned HTTP ${status} for ${url}`);
    this.name = "GoogleFontsHttpError";
  }
}

// ── Virtual module IDs ────────────────────────────────────────────────────────

export const VIRTUAL_GOOGLE_FONTS = "virtual:vinext-google-fonts";
export const RESOLVED_VIRTUAL_GOOGLE_FONTS = "\0" + VIRTUAL_GOOGLE_FONTS;

// ── Constants ─────────────────────────────────────────────────────────────────

// IMPORTANT: keep this set in sync with the non-default exports from
// packages/vinext/src/shims/font-google.ts (and its re-export barrel).
const GOOGLE_FONT_UTILITY_EXPORTS = new Set([
  "buildGoogleFontsUrl",
  "getSSRFontLinks",
  "getSSRFontStyles",
  "getSSRFontPreloads",
  "createFontLoader",
]);

/**
 * Served URL prefix for self-hosted Google Font files.
 *
 * `fetchAndCacheFont()` downloads font files into `<root>/.vinext/fonts/`
 * and writes an `@font-face` CSS snippet whose `src: url(...)` references
 * name each file relative to that cache directory, behind
 * `CACHED_FONT_DIR_TOKEN`. Before the CSS is embedded in the bundle as
 * `_vinext.font.selfHostedCSS`, `_rewriteCachedFontCssToServedUrls()`
 * replaces the token with this URL prefix, and the matching `writeBundle`
 * hook in `createGoogleFontsPlugin` copies the font files into
 * `<clientOutDir>/<assetsDir>/_vinext_fonts/` so the URL actually resolves
 * against the origin at request time.
 *
 * The leading `_` keeps the namespace distinct from Vite's content-hashed
 * asset names (which are emitted flat into `<assetsDir>/`) and from any
 * user-provided public files.
 */
const VINEXT_FONT_URL_NAMESPACE = "_vinext_fonts";
const MAX_GOOGLE_FONTS_ERROR_BODY_LENGTH = 500;

/**
 * Stands in for the font cache directory in every `url()` of a cached
 * stylesheet, so the file on disk holds no absolute path and reads the same
 * wherever the checkout's `.vinext/` ends up: a moved or copied project, a
 * CI cache restored into another workspace, or a Docker build that copies
 * in a host's `.vinext/`. Next.js has no such cache (its Google font loader
 * keeps fetched CSS in memory and emits `/_next/static/media` URLs), so the
 * parity target is output that does not depend on where the cache was
 * written.
 */
const CACHED_FONT_DIR_TOKEN = "__VINEXT_FONT_CACHE_DIR__";

/**
 * Cached stylesheet whose `url()` references use `CACHED_FONT_DIR_TOKEN`.
 * The suffix ties the cache to that format: a `style.css` written by an
 * earlier vinext holds the writing checkout's absolute paths, which would
 * 404 once embedded, and a `style-q7f3kd.css` names extensionless Google
 * font URLs `.ttf` whatever their format, so neither is read and the font
 * is fetched again. Change the suffix whenever the cached CSS format
 * changes.
 */
const CACHED_FONT_CSS_FILE = "style-h8r2vn.css";

function formatGoogleFontsErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "(empty response body)";
  if (trimmed.length <= MAX_GOOGLE_FONTS_ERROR_BODY_LENGTH) return trimmed;
  const omitted = trimmed.length - MAX_GOOGLE_FONTS_ERROR_BODY_LENGTH;
  return `${trimmed.slice(0, MAX_GOOGLE_FONTS_ERROR_BODY_LENGTH)}\n... (truncated ${omitted} characters)`;
}

/**
 * Point the `@font-face { src: url(...) }` references of cached Google Fonts
 * CSS at the served URL the plugin's `writeBundle` hook copies the font
 * files to (and the dev middleware serves them from), by replacing
 * `CACHED_FONT_DIR_TOKEN` with `/<assetsDir>/_vinext_fonts`.
 *
 * This is called once per transform, before the CSS string is embedded in
 * the bundle as `_vinext.font.selfHostedCSS`. Every downstream consumer reads
 * from the same rewritten CSS: the injected `<style data-vinext-fonts>` block, the
 * HTML body's `<link rel="preload">` tags (via `collectFontPreloadsFromCSS`
 * in `shims/font-google-base.ts`), and the HTTP `Link:` response header
 * (via `buildAppPageFontLinkHeader` in `server/app-page-execution.ts`).
 *
 * The token is substituted with plain split/join: it is a fixed string
 * vinext wrote itself, so nothing about the checkout's path (spaces, quotes,
 * parentheses, regex metacharacters, Windows separators) is parsed here.
 *
 * `assetsDir` must match whatever Vite has resolved for
 * `build.assetsDir` on the client environment — otherwise the embedded
 * CSS URLs and the files emitted by the `writeBundle` hook would diverge
 * and a user who customizes `build.assetsDir` (e.g. to `"static"`) would
 * see 404s on every preload. The call site in `injectSelfHostedCss`
 * passes the resolved value through from plugin state. The default is
 * kept only so the exported helper can be driven directly from unit
 * tests without synthesizing a full plugin context.
 */
export function _rewriteCachedFontCssToServedUrls(
  css: string,
  assetsDir: string = DEFAULT_ASSETS_DIR,
): string {
  return css
    .split(CACHED_FONT_DIR_TOKEN)
    .join(`/${assetsDir || DEFAULT_ASSETS_DIR}/${VINEXT_FONT_URL_NAMESPACE}`);
}

/**
 * Default `build.assetsDir` — matches vinext's resolved default in
 * `resolveAssetsDir("")` (Next.js's canonical convention). Used as the
 * fallback for the `assetsDir` parameter of
 * `_rewriteCachedFontCssToServedUrls` so the exported helper can be unit
 * tested without synthesizing plugin state. Production call sites thread
 * the real `envConfig.build.assetsDir` resolved by Vite through so that
 * the embedded CSS URLs always match the directory the `writeBundle`
 * hook copies the font files into.
 */
const DEFAULT_ASSETS_DIR = ASSET_PREFIX_URL_DIR;

// ── Types ─────────────────────────────────────────────────────────────────────

// ── Helpers shared with index.ts ──────────────────────────────────────────────

/**
 * Safely parse a static JS object literal string into a plain object.
 * Uses Vite's bundled oxc parser so no code is ever evaluated.
 * Returns null if the expression contains anything dynamic (function calls,
 * template literals, identifiers, computed properties, etc.).
 *
 * Supports: string literals, numeric literals, boolean literals,
 * arrays of the above, and nested object literals.
 */
export function parseStaticObjectLiteral(objectStr: string): Record<string, unknown> | null {
  let ast: ESTree.Program;
  try {
    // Wrap in parens so the parser treats `{…}` as an expression, not a block
    ast = parseProgram(`(${objectStr})`);
  } catch {
    return null;
  }

  // The AST should be: Program > ExpressionStatement > ObjectExpression
  const body = ast.body;
  if (body.length !== 1 || body[0].type !== "ExpressionStatement") return null;

  const expr = body[0].expression;
  if (expr.type !== "ObjectExpression") return null;

  const result = extractStaticValue(expr);
  return result === undefined ? null : (result as Record<string, unknown>);
}

/**
 * Recursively extract a static value from an ESTree AST node.
 * Returns undefined (not null) if the node contains any dynamic expression.
 *
 * Uses `any` for the node parameter because Rollup's internal ESTree types
 * (estree.Expression, estree.ObjectExpression, etc.) aren't re-exported by Vite,
 * and the recursive traversal touches many different node shapes.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
function extractStaticValue(node: any): unknown {
  switch (node.type) {
    case "Literal":
      // String, number, boolean, null
      return node.value;

    case "UnaryExpression":
      // Handle negative numbers: -1, -3.14
      if (
        node.operator === "-" &&
        node.argument?.type === "Literal" &&
        typeof node.argument.value === "number"
      ) {
        return -node.argument.value;
      }
      return undefined;

    case "ArrayExpression": {
      const arr: unknown[] = [];
      for (const elem of node.elements) {
        if (!elem) return undefined; // sparse array
        const val = extractStaticValue(elem);
        if (val === undefined) return undefined;
        arr.push(val);
      }
      return arr;
    }

    case "ObjectExpression": {
      const obj: Record<string, unknown> = {};
      for (const prop of node.properties) {
        if (prop.type !== "Property") return undefined; // SpreadElement etc.
        if (prop.computed) return undefined; // [expr]: val

        // Key can be Identifier (unquoted) or Literal (quoted)
        let key: string;
        if (prop.key.type === "Identifier") {
          key = prop.key.name;
        } else if (prop.key.type === "Literal" && typeof prop.key.value === "string") {
          key = prop.key.value;
        } else {
          return undefined;
        }

        const val = extractStaticValue(prop.value);
        if (val === undefined) return undefined;
        obj[key] = val;
      }
      return obj;
    }

    default:
      // TemplateLiteral, CallExpression, Identifier, etc. — reject
      return undefined;
  }
}

// ── Virtual module encoding/decoding ─────────────────────────────────────────

function encodeGoogleFontsVirtualId(payload: {
  hasDefault: boolean;
  fonts: string[];
  utilities: string[];
}): string {
  const params = new URLSearchParams();
  if (payload.hasDefault) params.set("default", "1");
  if (payload.fonts.length > 0) params.set("fonts", payload.fonts.join(","));
  if (payload.utilities.length > 0) params.set("utilities", payload.utilities.join(","));
  return `${VIRTUAL_GOOGLE_FONTS}?${params.toString()}`;
}

function parseGoogleFontsVirtualId(id: string): {
  hasDefault: boolean;
  fonts: string[];
  utilities: string[];
} | null {
  const cleanId = id.startsWith("\0") ? id.slice(1) : id;
  if (!cleanId.startsWith(VIRTUAL_GOOGLE_FONTS)) return null;
  const queryIndex = cleanId.indexOf("?");
  const params = new URLSearchParams(queryIndex === -1 ? "" : cleanId.slice(queryIndex + 1));
  return {
    hasDefault: params.get("default") === "1",
    fonts:
      params
        .get("fonts")
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? [],
    utilities:
      params
        .get("utilities")
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? [],
  };
}

export function generateGoogleFontsVirtualModule(
  id: string,
  fontGoogleShimPath: string,
): string | null {
  const payload = parseGoogleFontsVirtualId(id);
  if (!payload) return null;

  const utilities = Array.from(new Set(payload.utilities));
  const fonts = Array.from(new Set(payload.fonts));
  const lines: string[] = [];

  lines.push(`import { createFontLoader } from ${JSON.stringify(fontGoogleShimPath)};`);

  const reExports: string[] = [];
  if (payload.hasDefault) reExports.push("default");
  reExports.push(...utilities);
  if (reExports.length > 0) {
    lines.push(`export { ${reExports.join(", ")} } from ${JSON.stringify(fontGoogleShimPath)};`);
  }

  for (const fontName of fonts) {
    const family = fontName.replace(/_/g, " ");
    lines.push(
      `export const ${fontName} = /*#__PURE__*/ createFontLoader(${JSON.stringify(family)});`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

/** Font file extensions `next/font/local` paths are promoted to asset imports for. */
const LOCAL_FONT_FILE_RE = /\.(?:woff2?|ttf|otf|eot)$/;

// ── AST helpers ───────────────────────────────────────────────────────────────

type CallExpressionNode = Extract<ESTree.Node, { type: "CallExpression" }>;
type ObjectExpressionNode = Extract<ESTree.Node, { type: "ObjectExpression" }>;

/**
 * Parse a module for the font transforms, or `null` when it is not a script
 * module or does not parse. Vite's own transform rejects the same syntax
 * error, so skipping the rewrite only leaves that error to it.
 */
function parseFontModule(code: string, id: string): ESTree.Program | null {
  const lang = scriptParserLanguage(id);
  if (!lang) return null;
  try {
    return parseProgram(code, { lang });
  } catch {
    return null;
  }
}

/**
 * The single object-literal argument of a font loader call, e.g. the
 * `{ subsets: ["latin"] }` in `Inter({ subsets: ["latin"] })`. Calls with
 * no argument, a non-literal argument, or extra arguments are not
 * statically analyzable and are left alone.
 */
function soleObjectArgument(call: CallExpressionNode): ObjectExpressionNode | null {
  if (call.arguments.length !== 1) return null;
  const arg = call.arguments[0];
  return arg.type === "ObjectExpression" ? arg : null;
}

/**
 * Where and how to add one more property to an options object literal: just
 * before its closing `}`, with a `, ` separator unless the object is empty or
 * already ends in a trailing comma. The gap between the last property and the
 * `}` holds only whitespace, comments, and that optional comma, so skipping
 * the trivia finds the comma even behind a comment (`{ a: 1, /* note *\/ }`),
 * and a `//` inside a string value is never in the gap to begin with.
 */
function propertyInsertion(
  code: string,
  object: ObjectExpressionNode,
): { at: number; separator: string } {
  const at = object.end - 1;
  const last = object.properties.at(-1);
  if (!last) return { at, separator: "" };
  const gap = code.slice(last.end, at);
  const triviaLength = LEADING_TRIVIA_RE.exec(gap)?.[0].length ?? 0;
  return { at, separator: gap[triviaLength] === "," ? "" : ", " };
}

function hasPropertyNamed(object: ObjectExpressionNode, name: string): boolean {
  return object.properties.some(
    (prop) => prop.type === "Property" && !prop.computed && getAstName(prop.key) === name,
  );
}

function propertyNameToGoogleFontFamily(prop: string): string {
  return prop.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

// ── Font fetching and caching ─────────────────────────────────────────────────

/**
 * Fetch Google Fonts CSS, download .woff2 files, cache locally, and return
 * @font-face CSS whose `url()` references use `CACHED_FONT_DIR_TOKEN`.
 *
 * Cache dir structure: .vinext/fonts/<family-hash>/
 *   - style-<suffix>.css (the rewritten @font-face CSS, see `CACHED_FONT_CSS_FILE`)
 *   - *.woff2 (downloaded font files)
 */
async function fetchAndCacheFont(
  cssUrl: string,
  family: string,
  cacheDir: string,
): Promise<string> {
  // Use a hash of the URL for the cache key
  const { createHash } = await import("node:crypto");
  const urlHash = createHash("md5").update(cssUrl).digest("hex").slice(0, 12);
  const fontDirName = `${family.toLowerCase().replace(/\s+/g, "-")}-${urlHash}`;
  const fontDir = path.join(cacheDir, fontDirName);

  // Check if already cached
  const cachedCSSPath = path.join(fontDir, CACHED_FONT_CSS_FILE);
  if (fs.existsSync(cachedCSSPath)) {
    return fs.readFileSync(cachedCSSPath, "utf-8");
  }

  const css = await downloadGoogleFont(cssUrl, family, fontDir, fontDirName);

  // Cache the rewritten CSS. Failing to (a read-only or full disk) loses
  // only the cache: the CSS and every file it names are already on disk, so
  // this build still self-hosts and the next one tries to cache it again.
  try {
    writeFileAtomically(cachedCSSPath, css);
  } catch {}
  return css;
}

/**
 * Write-then-rename, so a write that fails midway never leaves a partial
 * file for a later build to trust: both font files and the stylesheet are
 * reused as soon as they exist.
 */
function writeFileAtomically(filePath: string, data: string | Buffer): void {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
}

async function downloadGoogleFont(
  cssUrl: string,
  family: string,
  fontDir: string,
  fontDirName: string,
): Promise<string> {
  const { createHash } = await import("node:crypto");
  // Fetch CSS from Google Fonts (woff2 user-agent gives woff2 URLs)
  const cssResponse = await fetch(cssUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });
  if (!cssResponse.ok) {
    // Include the response body when Google rejected the request so the
    // caller can see why (the body usually contains a one-line CSS comment
    // identifying the bad axis or family).
    const body = await cssResponse.text().catch(() => "");
    throw new GoogleFontsHttpError(cssUrl, cssResponse.status, body);
  }
  let css = await cssResponse.text();
  // `ok` is also true for a bodyless 204. Caching an empty stylesheet would
  // be trusted by every later build, so treat it like a failed fetch: the caller falls back and the next
  // build retries.
  if (!css.trim()) {
    throw new Error(`Google Fonts returned an empty stylesheet: ${cssUrl}`);
  }

  // Extract all font file URLs. The extension comes from the shared Next.js
  // port, which also resolves extensionless `/l/font?kit=...` URLs.
  const urls = new Map<string, string>(); // original URL -> local filename
  for (const { googleFontFileUrl: fontUrl, ext } of findFontFilesInCss(css)) {
    if (!fontUrl.startsWith("https://fonts.gstatic.com/")) continue;
    const fileHash = createHash("md5").update(fontUrl).digest("hex").slice(0, 8);
    urls.set(fontUrl, `${family.toLowerCase().replace(/\s+/g, "-")}-${fileHash}.${ext}`);
  }

  // Download font files
  fs.mkdirSync(fontDir, { recursive: true });
  for (const [fontUrl, filename] of urls) {
    const filePath = path.join(fontDir, filename);
    if (!fs.existsSync(filePath)) {
      const fontResponse = await fetch(fontUrl);
      // The stylesheet is cached only once every file it names is on disk,
      // and a cached stylesheet is trusted from then on. Skipping a failed
      // or empty download (`ok` is also true for a bodyless 204) would cache
      // a reference to a file that 404s or fails to decode on every later
      // build, so fail this attempt instead: the caller falls back to the
      // runtime CDN path, and the next build retries.
      if (!fontResponse.ok) {
        throw new Error(`Font file download failed with HTTP ${fontResponse.status}: ${fontUrl}`);
      }
      const buffer = Buffer.from(await fontResponse.arrayBuffer());
      if (buffer.byteLength === 0) {
        throw new Error(`Font file download returned an empty body: ${fontUrl}`);
      }
      writeFileAtomically(filePath, buffer);
    }
    // Rewrite every remote Google Fonts CDN URL in the cached CSS to the
    // locally-downloaded file, named relative to the cache directory behind
    // `CACHED_FONT_DIR_TOKEN`. `_rewriteCachedFontCssToServedUrls()` swaps
    // the token for the served URL namespace under
    // `/<assetsDir>/_vinext_fonts/` at embed time. Writing the token rather
    // than an absolute filesystem path keeps the checkout's location out of
    // the cache, so a `.vinext/` that is moved, copied, or restored into
    // another workspace still embeds URLs that `writeBundle` serves. No
    // filesystem path may reach the bundle, the injected `<style
    // data-vinext-fonts>` block, the HTML `<link rel="preload">` tags, or
    // the HTTP `Link:` response header. An earlier version of this code
    // claimed "Vite will resolve /@fs/ for dev, or asset for build", which
    // was never true: the CSS is embedded as a JavaScript string literal and
    // Vite's asset pipeline does not scan string literals. Do not resurrect
    // that assumption.
    css = css.split(fontUrl).join(`${CACHED_FONT_DIR_TOKEN}/${fontDirName}/${filename}`);
  }

  return css;
}

// ── Plugin factories ──────────────────────────────────────────────────────────

/**
 * Create the `vinext:google-fonts` Vite plugin.
 *
 * @param fontGoogleShimPath - Absolute path to the font-google shim module
 *   (either `.ts` in source or `.js` in built packages). Resolved by the caller
 *   so the plugin file has no dependency on `__dirname`.
 * @param shimsDir - Absolute path to the shims directory. Used to skip shim
 *   files from transform (they contain `next/font/google` references that must
 *   not be rewritten).
 */
export function createGoogleFontsPlugin(fontGoogleShimPath: string, shimsDir: string): Plugin {
  // Vite does not bind `this` to the plugin object when calling hooks, so
  // plugin state must be held in closure variables rather than as properties.
  const fontCache = new Map<string, string>(); // url -> local @font-face CSS
  let cacheDir = "";

  return {
    name: "vinext:google-fonts",
    enforce: "pre",

    configResolved(config) {
      cacheDir = path.join(toSlash(config.root), ".vinext", "fonts");
    },

    // Dev-mode equivalent of the production `writeBundle` copy step. In dev
    // there is no client output directory to copy files into, so the cached
    // .vinext/fonts/ tree is served directly under the same URL prefix that
    // `_rewriteCachedFontCssToServedUrls()` embeds into the @font-face CSS
    // (`/<assetsDir>/_vinext_fonts/...`). Without this hook the rewritten
    // URLs 404 — and once `_vinext.font.selfHostedCSS` is injected, the shim no longer
    // emits the fonts.googleapis.com `<link>`, so a 404 here means no
    // glyphs render at all (no CDN fallback path).
    configureServer(server) {
      if (!cacheDir) return;
      const assetsDir =
        server.environments?.client?.config?.build?.assetsDir ??
        server.config?.build?.assetsDir ??
        DEFAULT_ASSETS_DIR;
      const urlPrefix = `/${assetsDir}/${VINEXT_FONT_URL_NAMESPACE}/`;
      server.middlewares.use((req, res, next) => {
        const url = req.url;
        if (!url || !url.startsWith(urlPrefix)) return next();
        const rawPath = url.slice(urlPrefix.length).split("?")[0];
        let decoded: string;
        try {
          decoded = decodeURIComponent(rawPath);
        } catch {
          return next();
        }
        const filePath = path.resolve(cacheDir, decoded);
        // Path traversal guard — `decoded` came from the URL, so refuse
        // anything that escapes the cache root (e.g. `..%2F..%2Fetc/passwd`).
        if (filePath !== cacheDir && !filePath.startsWith(cacheDir + path.sep)) {
          return next();
        }
        fs.stat(filePath, (err, stat) => {
          if (err || !stat.isFile()) return next();
          const ext = path.extname(filePath).toLowerCase();
          // CONTENT_TYPES is the same map prod-server uses, so fonts get
          // identical MIME types in dev and prod. fetchAndCacheFont only
          // ever writes .woff2/.woff/.ttf/.otf/.eot, all of which are covered.
          res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Access-Control-Allow-Origin", "*");
          fs.createReadStream(filePath).pipe(res);
        });
      });
    },

    transform: {
      // Hook filter: only invoke JS when code contains 'next/font/google'.
      // This still eliminates nearly all Rust-to-JS calls since very few files
      // import from next/font/google.
      filter: {
        id: {
          include: /\.(tsx?|jsx?|mjs)$/,
        },
        code: "next/font/google",
      },
      async handler(code, id) {
        // Defensive guard — duplicates filter logic
        if (id.startsWith("\0")) return null;
        if (!id.match(/\.(tsx?|jsx?|mjs)$/)) return null;
        if (!code.includes("next/font/google")) return null;
        if (id.startsWith(shimsDir)) return null;

        // Read the resolved `build.assetsDir` from the current Vite
        // environment so it can be closed over by the inner
        // `injectSelfHostedCss` helper (a plain function declaration
        // where `this` is untyped). Captured at the top of the hook so
        // a single handler invocation always threads one consistent
        // value through every font-loader call site it rewrites.
        const transformAssetsDir = this.environment?.config?.build?.assetsDir ?? DEFAULT_ASSETS_DIR;

        const program = parseFontModule(code, id);
        if (!program) return null;

        const s = new MagicString(code);
        let hasChanges = false;
        let proxyImportCounter = 0;
        const fontLocals = new Map<string, string>();
        const proxyObjectLocals = new Set<string>();

        // Imports and re-exports are read from the program's top-level
        // declarations, so a `next/font/google` mention in a comment or a
        // string is never mistaken for one, a preceding semicolon-less line
        // can't be merged into the clause, and a multi-line (Prettier-wrapped)
        // bracket import is just another declaration. Rewrites only swap the
        // module specifier: the clause stays verbatim, type-only specifiers
        // included, for TypeScript to erase.
        for (const node of program.body) {
          if (node.type === "ImportDeclaration") {
            if (node.source.value !== "next/font/google" || node.importKind === "type") continue;
            let defaultLocal: string | null = null;
            let namespaceLocal: string | null = null;
            const fontNames: string[] = [];
            const utilityNames: string[] = [];
            for (const spec of node.specifiers) {
              if (spec.type === "ImportDefaultSpecifier") {
                defaultLocal = spec.local.name;
              } else if (spec.type === "ImportNamespaceSpecifier") {
                namespaceLocal = spec.local.name;
              } else if (spec.importKind !== "type") {
                const imported = getAstName(spec.imported);
                if (imported === "default") {
                  defaultLocal = spec.local.name;
                } else if (imported && GOOGLE_FONT_UTILITY_EXPORTS.has(imported)) {
                  utilityNames.push(imported);
                } else if (imported) {
                  fontNames.push(imported);
                  fontLocals.set(spec.local.name, imported);
                }
              }
            }
            if (defaultLocal) proxyObjectLocals.add(defaultLocal);

            if (fontNames.length > 0) {
              const virtualId = encodeGoogleFontsVirtualId({
                hasDefault: Boolean(defaultLocal),
                fonts: Array.from(new Set(fontNames)),
                utilities: Array.from(new Set(utilityNames)),
              });
              s.overwrite(node.source.start, node.source.end, JSON.stringify(virtualId));
              hasChanges = true;
              continue;
            }

            if (namespaceLocal) {
              const proxyImportName = `__vinext_google_fonts_proxy_${proxyImportCounter++}`;
              const replacementLines = [
                `import ${proxyImportName} from ${JSON.stringify(fontGoogleShimPath)};`,
              ];
              if (defaultLocal) {
                replacementLines.push(`var ${defaultLocal} = ${proxyImportName};`);
              }
              replacementLines.push(`var ${namespaceLocal} = ${proxyImportName};`);
              s.overwrite(node.start, node.end, replacementLines.join("\n"));
              proxyObjectLocals.add(namespaceLocal);
              hasChanges = true;
            }
            continue;
          }

          if (node.type === "ExportNamedDeclaration") {
            if (node.source?.value !== "next/font/google" || node.exportKind === "type") continue;
            let hasDefault = false;
            const fontNames: string[] = [];
            const utilityNames: string[] = [];
            for (const spec of node.specifiers) {
              if (spec.exportKind === "type") continue;
              const exported = getAstName(spec.local);
              if (exported === "default") {
                hasDefault = true;
              } else if (exported && GOOGLE_FONT_UTILITY_EXPORTS.has(exported)) {
                utilityNames.push(exported);
              } else if (exported) {
                fontNames.push(exported);
              }
            }
            if (fontNames.length === 0) continue;

            const virtualId = encodeGoogleFontsVirtualId({
              hasDefault,
              fonts: Array.from(new Set(fontNames)),
              utilities: Array.from(new Set(utilityNames)),
            });
            s.overwrite(node.source.start, node.source.end, JSON.stringify(virtualId));
            hasChanges = true;
          }
        }

        async function injectSelfHostedCss(options: ObjectExpressionNode, family: string) {
          // Read the options straight off the AST — no eval/new Function.
          // Anything dynamic (identifiers, calls, spreads...) makes the call
          // not statically analyzable, so it is skipped.
          const staticOptions = extractStaticValue(options);
          if (staticOptions === undefined) return;

          // Validate the call against the bundled Google Fonts metadata
          // and resolve the actual axis values. This replaces an earlier
          // inline URL builder that hardcoded `:wght@100..900` regardless
          // of the font's real `wght` axis range, which produced HTTP 400
          // for fonts whose axis is narrower (Sen 400..800, Anton 400).
          // See issue #885.
          let validated;
          try {
            validated = validateGoogleFontOptions(family, staticOptions as Record<string, unknown>);
          } catch (err) {
            // Validation errors are programmer errors (unknown family,
            // missing required weight on a static font, etc.). Re-throw
            // with the file path attached so Vite reports the offending
            // call site instead of a generic plugin error.
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`[vinext:google-fonts] ${id}: ${message}`);
          }
          const axes = getFontAxes(
            family,
            validated.weights,
            validated.styles,
            validated.selectedVariableAxes,
          );
          const cssUrl = buildGoogleFontsUrl(family, axes, validated.display);

          // Check cache
          let localCSS = fontCache.get(cssUrl);
          if (!localCSS) {
            try {
              localCSS = await fetchAndCacheFont(cssUrl, family, cacheDir);
              fontCache.set(cssUrl, localCSS);
            } catch (err) {
              if (err instanceof GoogleFontsHttpError) {
                // HTTP 4xx/5xx from Google means the URL is malformed or
                // the family/axis combination is invalid. Surface as a
                // build error so the user sees the failing URL plus
                // Google's response body, rather than silently falling
                // through to a CDN URL that ships the same bad request
                // to the browser.
                throw new Error(
                  `[vinext:google-fonts] ${id}: Google Fonts returned HTTP ${err.status} for ${err.url}.\n${formatGoogleFontsErrorBody(err.responseBody)}`,
                );
              }
              // Network errors (offline, DNS, AbortError) and failed font
              // file downloads are recoverable; skip self-hosting and let the
              // runtime CDN path handle it.
              return;
            }
          }

          // Point the cached CSS's cache-relative font references at served
          // URLs under `/<assetsDir>/_vinext_fonts/` so the
          // embedded `_vinext.font.selfHostedCSS` string has origin-relative URLs that
          // the browser can actually resolve. The plugin's writeBundle hook
          // copies the referenced font files to the matching location under
          // the client output directory so the URLs serve 200s, not 404s.
          //
          // `transformAssetsDir` is captured at the top of the outer
          // transform handler (where `this.environment` is bound by
          // Rollup to the plugin context) and closed over here. This
          // keeps the embedded URL prefix in lockstep with the directory
          // the writeBundle hook copies files into, so a user who
          // customizes `build.assetsDir` (e.g. to `"static"`) sees both
          // the CSS and the copy target move together — otherwise the
          // rewritten URLs would 404 in production.
          const servedCSS = _rewriteCachedFontCssToServedUrls(localCSS, transformAssetsDir);
          const preloadUrls = findFontFilesInCss(
            servedCSS,
            validated.preload ? validated.subsets : undefined,
          )
            .filter((file) => file.preloadFontFile)
            .map((file) => file.googleFontFileUrl);
          const fallbackMetrics =
            validated.adjustFontFallback === false
              ? undefined
              : getFallbackFontOverrideMetrics(family);
          const adjustedFallbackCSS = fallbackMetrics
            ? buildFallbackFontFace(family, fallbackMetrics)
            : undefined;
          const validatedFontWeight =
            validated.weights.length === 1 && validated.weights[0] !== "variable"
              ? Number(validated.weights[0])
              : undefined;
          const validatedFontStyle =
            validated.styles.length === 1 ? validated.styles[0] : undefined;

          // Inject the internal transform-to-runtime payload into the options object.
          const internalFontProperties = [
            `selfHostedCSS: ${JSON.stringify(servedCSS)}`,
            `preloadUrls: ${JSON.stringify(preloadUrls)}`,
          ];
          if (adjustedFallbackCSS) {
            internalFontProperties.push(
              `adjustedFallbackCSS: ${JSON.stringify(adjustedFallbackCSS)}`,
            );
          }
          if (Number.isFinite(validatedFontWeight)) {
            internalFontProperties.push(`fontWeight: ${validatedFontWeight}`);
          }
          if (validatedFontStyle) {
            internalFontProperties.push(`fontStyle: ${JSON.stringify(validatedFontStyle)}`);
          }
          const injectedProperties = [
            `_vinext: { font: { ${internalFontProperties.join(", ")} } }`,
          ];
          // Add the payload as one more property of the options object, right
          // before its closing brace; see `propertyInsertion` for the
          // separator.
          const { at, separator } = propertyInsertion(code, options);
          s.appendLeft(at, separator + injectedProperties.join(", "));
          hasChanges = true;
        }

        // Self-host injection runs in both dev and build. In dev, the
        // companion `configureServer` hook serves the cached files
        // directly from `.vinext/fonts/` so the rewritten URLs resolve
        // against the dev origin; in build, the `writeBundle` hook copies
        // them into the client output directory.
        //
        // Font loader calls are `Inter({...})` for a named font import and
        // `googleFonts.Inter({...})` for a default or namespace import. Being
        // AST call expressions, commented-out calls and look-alikes inside
        // strings are never rewritten.
        const fontCalls: Array<{ options: ObjectExpressionNode; family: string }> = [];
        walkAst(program, (node) => {
          if (node.type !== "CallExpression") return;
          const options = soleObjectArgument(node);
          if (!options) return;
          const callee = node.callee;
          let family: string | null = null;
          if (callee.type === "Identifier") {
            const imported = fontLocals.get(callee.name);
            if (imported) family = imported.replace(/_/g, " ");
          } else if (
            callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.object.type === "Identifier" &&
            proxyObjectLocals.has(callee.object.name) &&
            callee.property.type === "Identifier"
          ) {
            family = propertyNameToGoogleFontFamily(callee.property.name);
          }
          if (!family) return;
          fontCalls.push({ options, family });
          // The options are static literals, so nothing below can be another
          // font call.
          return false;
        });
        for (const { options, family } of fontCalls) {
          await injectSelfHostedCss(options, family);
        }

        if (!hasChanges) return null;
        return magicStringTransformResult(s);
      },
    },

    // Copy cached Google Font files into the client output so the served
    // URLs produced by `_rewriteCachedFontCssToServedUrls` resolve against
    // the origin. Runs once, at the end of the client environment's build.
    //
    // `fetchAndCacheFont` downloads files into `<root>/.vinext/fonts/` and
    // leaves them there — nothing else copies them. Without this hook, the
    // rewritten `/assets/_vinext_fonts/...` URLs would 404 in production.
    writeBundle: {
      sequential: true,
      order: "post" as const,
      handler(outputOptions: { dir?: string }) {
        // Only copy on the client build — the server/SSR environments
        // don't serve static assets.
        //
        // Optional chaining on `this.environment` matches the convention
        // used by the other build-time plugins in `src/index.ts` (the
        // `vinext:precompress` and `vinext:cloudflare-build` plugins both
        // guard on `this.environment?.name !== "client"`). Vite 6+ always
        // populates `this.environment` inside writeBundle, but keeping
        // the guard makes the hook safely no-op if the code is ever
        // executed in a context where Rollup invokes it without a bound
        // environment (e.g. a thin unit test harness that invokes the
        // hook directly). Concretely: under normal Vite builds this
        // always resolves, the early-return is never taken.
        if (this.environment?.name !== "client") return;
        if (!cacheDir || !fs.existsSync(cacheDir)) return;
        const outDir = outputOptions.dir;
        if (!outDir) return;

        // Read the resolved `build.assetsDir` from the same environment
        // that the transform-time rewrite read it from, so the embedded
        // URL prefix and the physical copy location cannot diverge even
        // if a user customizes `build.assetsDir`.
        const assetsDir = this.environment.config?.build?.assetsDir ?? DEFAULT_ASSETS_DIR;
        const targetRoot = path.join(outDir, assetsDir, VINEXT_FONT_URL_NAMESPACE);

        // Recursive copy of every cached font file. Skip the companion
        // stylesheet artifact — that is only read by the build plugin
        // itself, never served at runtime.
        const stack: string[] = [cacheDir];
        while (stack.length > 0) {
          const dir = stack.pop();
          if (!dir) continue;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const src = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              stack.push(src);
              continue;
            }
            if (!/\.(woff2?|ttf|otf|eot)$/i.test(entry.name)) continue;
            const relative = path.relative(cacheDir, src);
            const dest = path.join(targetRoot, relative);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
          }
        }
      },
    },
  } satisfies Plugin;
}

/**
 * Create the `vinext:local-fonts` Vite plugin.
 *
 * Rewrites relative font file paths in `next/font/local` calls into Vite
 * asset import references so that both dev (/@fs/...) and prod
 * (/assets/font-xxx.woff2) URLs resolve correctly.
 *
 * @param shimsDir - Absolute path to the shims directory (with trailing
 *   separator). Used to skip vinext's own shim files from transform — they
 *   contain example `next/font/local` paths in comments that must not be
 *   rewritten. A precise prefix check is required (rather than a loose
 *   substring match) because, now that `node_modules` is no longer excluded,
 *   the guard runs against arbitrary third-party package paths — some of
 *   which may legitimately contain the substring `font-local` (e.g. a
 *   package named `font-local-loader`) and must still be transformed. This
 *   mirrors `createGoogleFontsPlugin`, which takes `shimsDir` for the same
 *   reason.
 */
export function createLocalFontsPlugin(shimsDir: string): Plugin {
  return {
    name: "vinext:local-fonts",
    enforce: "pre",

    transform: {
      // NOTE: node_modules is intentionally NOT excluded here. npm packages
      // commonly wrap `next/font/local` and ship the font files alongside the
      // module (e.g. `geist/dist/mono.js` calls
      // `localFont({ src: "./fonts/geist-mono/GeistMono-Variable.woff2" })`).
      // Those relative `src` paths are resolved against the package's own
      // directory and must be promoted to Vite asset imports just like a user's
      // source files, otherwise the runtime `@font-face` references the raw
      // relative path and the font 404s. Next.js's font loader runs on these
      // package files too, so vinext must as well. The `code` filter plus the
      // default-import check below keep this from touching unrelated modules.
      filter: {
        id: {
          include: /\.(tsx?|jsx?|mjs)$/,
        },
        code: "next/font/local",
      },
      handler(code, id) {
        // Defensive guards — duplicate filter logic
        if (id.startsWith("\0")) return null;
        if (!id.match(/\.(tsx?|jsx?|mjs)$/)) return null;
        if (!code.includes("next/font/local")) return null;
        // Skip vinext's own shim files — the font-local shim contains example
        // paths in comments that would be incorrectly rewritten. A precise
        // prefix check against `shimsDir` (not a loose `id.includes("font-local")`
        // substring) is required now that node_modules is no longer excluded,
        // so legitimate third-party packages whose path happens to contain
        // `font-local` are still transformed. Mirrors `createGoogleFontsPlugin`.
        if (id.startsWith(shimsDir)) return null;

        // Find the default import from next/font/local and remember its local
        // binding so family payloads only attach to real localFont calls.
        const program = parseFontModule(code, id);
        if (!program) return null;
        let localFontIdentifier: string | null = null;
        for (const node of program.body) {
          if (node.type !== "ImportDeclaration" || node.source.value !== "next/font/local")
            continue;
          const defaultSpec = node.specifiers.find(
            (spec) => spec.type === "ImportDefaultSpecifier",
          );
          if (defaultSpec) {
            localFontIdentifier = defaultSpec.local.name;
            break;
          }
        }
        if (!localFontIdentifier) return null;

        const s = new MagicString(code);
        let hasChanges = false;
        let fontImportCounter = 0;
        const imports: string[] = [];

        walkAst(program, (node) => {
          // `path: "./font.woff2"` / `src: "./font.woff2"` — anywhere in the
          // module, so options declared in a variable and passed to
          // localFont() are covered too. Only real properties count: a path in
          // a comment or inside another string is not touched.
          if (node.type === "Property") {
            if (node.computed || node.value.type !== "Literal") return;
            const key = getAstName(node.key);
            const fontPath = node.value.value;
            if (key !== "path" && key !== "src") return;
            if (typeof fontPath !== "string" || !LOCAL_FONT_FILE_RE.test(fontPath)) return;

            // Import the font file — Vite resolves it as a static asset and
            // returns the correct URL for both dev and prod.
            const varName = `__vinext_local_font_${fontImportCounter++}`;
            imports.push(`import ${varName} from ${JSON.stringify(fontPath)};`);
            // Replace: path: "./font.woff2" -> path: __vinext_local_font_0
            s.overwrite(node.value.start, node.value.end, varName);
            hasChanges = true;
            return;
          }

          // `const myFont = localFont({...})`: tell the runtime the binding
          // name, which Next.js uses as the generated font family.
          if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") return;
          if (node.init?.type !== "CallExpression") return;
          const callee = node.init.callee;
          if (callee.type !== "Identifier" || callee.name !== localFontIdentifier) return;
          const options = soleObjectArgument(node.init);
          if (!options || hasPropertyNamed(options, "_vinext")) return;

          const { at, separator } = propertyInsertion(code, options);
          s.appendLeft(
            at,
            `${separator}_vinext: { font: { family: ${JSON.stringify(node.id.name)} } }`,
          );
          hasChanges = true;
        });

        if (!hasChanges) return null;

        // Prepend the asset imports at the top of the file
        if (imports.length > 0) {
          s.prepend(imports.join("\n") + "\n");
        }

        return magicStringTransformResult(s);
      },
    },
  } satisfies Plugin;
}
