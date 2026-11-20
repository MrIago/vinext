export type FontStyle = {
  fontFamily: string;
  fontWeight?: number;
  fontStyle?: string;
};

export type FontFaceStyleInput = {
  fontFamily: string;
  weight?: string | string[];
  style?: string | string[];
  internalWeight?: number;
  internalStyle?: string;
  google?: boolean;
};

/**
 * Escape a string for safe interpolation inside a CSS single-quoted string.
 *
 * Prevents CSS injection by escaping characters that could break out of
 * a `'...'` CSS string context: backslashes, single quotes, and newlines.
 *
 * Used by font-google-base.ts, font-local.ts, and fallback-metrics.ts.
 */
export function escapeCSSString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\a ")
    .replace(/\r/g, "\\d ");
}

/**
 * Validate a CSS custom property name (e.g. `--font-inter`).
 *
 * Custom properties must start with `--` and only contain alphanumeric
 * characters, hyphens, and underscores. Anything else could be used to
 * break out of the CSS declaration and inject arbitrary rules.
 *
 * Returns the name if valid, undefined otherwise.
 */
export function sanitizeCSSVarName(name: string): string | undefined {
  if (/^--[a-zA-Z0-9_-]+$/.test(name)) return name;
  return undefined;
}

/**
 * Sanitize a CSS font-family fallback name.
 *
 * Generic family names (sans-serif, serif, monospace, etc.) are used as-is.
 * Named families are wrapped in escaped quotes. This prevents injection via
 * crafted fallback values like `); } body { color: red; } .x {`.
 */
export function sanitizeFallback(name: string): string {
  // CSS generic font families — safe to use unquoted
  const generics = new Set([
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "emoji",
    "math",
    "fangsong",
  ]);
  const trimmed = name.trim();
  if (generics.has(trimmed)) return trimmed;
  // Wrap in single quotes with escaping to prevent CSS injection
  return `'${escapeCSSString(trimmed)}'`;
}

export function singleFontOptionValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    const values = new Set(value);
    return values.size === 1 ? value[0] : undefined;
  }
  return value;
}

export function sanitizeFontDescriptorValue(value: string): string | undefined {
  if (/[{};]|\/\*|\*\/|<\//i.test(value)) return undefined;
  return value;
}

export function resolveFontWeight(weight: string | string[] | undefined): number | undefined {
  const value = singleFontOptionValue(weight);
  if (!value || value.includes(" ")) return undefined;
  const numericWeight = Number(value);
  return Number.isFinite(numericWeight) ? numericWeight : undefined;
}

export function resolveFontStyle(style: string | string[] | undefined): string | undefined {
  const value = singleFontOptionValue(style);
  if (!value || value.includes(" ")) return undefined;
  return sanitizeFontDescriptorValue(value);
}

export function resolveGoogleFontStyle(style: string | string[] | undefined): string | undefined {
  if (style === undefined) return "normal";
  const value = singleFontOptionValue(style);
  if (!value) return undefined;
  if (value === "normal" || value === "italic") return value;
  return undefined;
}

export function resolveSingleFaceStyle(input: FontFaceStyleInput): FontStyle {
  const fontWeight = input.internalWeight ?? resolveFontWeight(input.weight);
  const internalStyle = input.internalStyle
    ? sanitizeFontDescriptorValue(input.internalStyle)
    : undefined;
  const fontStyle =
    internalStyle ??
    (input.google ? resolveGoogleFontStyle(input.style) : resolveFontStyle(input.style));

  return {
    fontFamily: input.fontFamily,
    ...(fontWeight !== undefined ? { fontWeight } : {}),
    ...(fontStyle ? { fontStyle } : {}),
  };
}

export function formatFontClassRule(className: string, style: FontStyle): string {
  const fontStyle = style.fontStyle ? sanitizeFontDescriptorValue(style.fontStyle) : undefined;
  const declarations = [
    `font-family: ${style.fontFamily}`,
    ...(style.fontWeight !== undefined ? [`font-weight: ${style.fontWeight}`] : []),
    ...(fontStyle ? [`font-style: ${fontStyle}`] : []),
  ];
  return `.${className} { ${declarations.join("; ")}; }\n`;
}

/**
 * Determine the preload `type` for a font file based on its extension.
 * Uses endsWith() only to avoid false positives from substring matches
 * (e.g. ".woff" matching ".woff2"). Matches Next.js, which emits
 * `font/${ext}` for every font preload (including `font/eot`).
 */
export function getFontMimeType(pathOrUrl: string): string {
  if (pathOrUrl.endsWith(".woff2")) return "font/woff2";
  if (pathOrUrl.endsWith(".woff")) return "font/woff";
  if (pathOrUrl.endsWith(".ttf")) return "font/ttf";
  if (pathOrUrl.endsWith(".otf")) return "font/otf";
  if (pathOrUrl.endsWith(".eot")) return "font/eot";
  return "font/woff2";
}

// The font stylesheet URLs collected during SSR, rendered as
// `<link rel="stylesheet">` by every router through `getSSRFontLinks()` in
// the Google font shim. Both shims write to it, so it lives on a
// `Symbol.for` slot like the rest of the shims' shared state.
const _SSR_FONT_URLS_KEY = Symbol.for("vinext.font.ssrFontUrls");
type _FontUrlsGlobal = typeof globalThis & { [_SSR_FONT_URLS_KEY]?: string[] };

export function getSSRFontStylesheetUrls(): string[] {
  return ((globalThis as _FontUrlsGlobal)[_SSR_FONT_URLS_KEY] ??= []);
}

/**
 * Load a font stylesheet: collected for the server-rendered head, or linked
 * from the document on the client unless the server already rendered it.
 */
export function addFontStylesheet(url: string): void {
  if (typeof document === "undefined") {
    const urls = getSSRFontStylesheetUrls();
    if (!urls.includes(url)) urls.push(url);
    return;
  }
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    if (link.getAttribute("href")?.split("?")[0] === url.split("?")[0]) return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  document.head.appendChild(link);
}

/**
 * Validate a CSS property name for use in declarations.
 *
 * Only allows standard CSS property names (lowercase letters and hyphens)
 * and custom properties (--prefixed). Rejects anything that could inject
 * CSS rules via crafted property names.
 */
function sanitizeCSSProperty(prop: string): string | undefined {
  if (/^(--)?[a-zA-Z][a-zA-Z0-9-]*$/.test(prop)) return prop;
  return undefined;
}

export type LocalFontSrc = {
  path: string;
  weight?: string;
  style?: string;
};

type LocalFontFaceOptions = {
  display?: string;
  weight?: string;
  style?: string;
  declarations?: Array<{ prop: string; value: string }>;
};

/**
 * The `@font-face` rules for a `next/font/local` call. Shared by the
 * `vinext:local-fonts` transform, which extracts them into a stylesheet at
 * build time, and the runtime shim, which injects them for calls the
 * transform could not analyze, so both produce the same CSS.
 */
export function generateLocalFontFaceCSS(
  family: string,
  options: LocalFontFaceOptions,
  sources: LocalFontSrc[],
): string {
  const display = options.display ?? "swap";
  const rules: string[] = [];

  for (const src of sources) {
    // Do not invent a default weight when neither level specifies one. The
    // @font-face descriptor defaults to `auto`; emitting `400` instead clamps
    // a variable font's `wght` axis. Next.js likewise omits it in this case.
    const configuredWeight = src.weight ?? options.weight;
    const weight =
      configuredWeight === undefined
        ? undefined
        : (sanitizeFontDescriptorValue(configuredWeight) ?? "400");
    const style = sanitizeFontDescriptorValue(src.style ?? options.style ?? "normal") ?? "normal";
    const format = src.path.endsWith(".woff2")
      ? "woff2"
      : src.path.endsWith(".woff")
        ? "woff"
        : src.path.endsWith(".ttf")
          ? "truetype"
          : src.path.endsWith(".otf")
            ? "opentype"
            : "woff2";

    rules.push(`@font-face {
  font-family: '${escapeCSSString(family)}';
  src: url('${escapeCSSString(src.path)}') format('${format}');
${weight === undefined ? "" : `  font-weight: ${weight};\n`}  font-style: ${style};
  font-display: ${display};
}`);
  }

  // Add extra declarations if provided — sanitize prop/value to prevent injection
  if (options.declarations) {
    for (const decl of options.declarations) {
      const safeProp = sanitizeCSSProperty(decl.prop);
      const safeValue = sanitizeFontDescriptorValue(decl.value);
      if (safeProp && safeValue) {
        rules.push(
          `@font-face { font-family: '${escapeCSSString(family)}'; ${safeProp}: ${safeValue}; }`,
        );
      }
    }
  }

  return rules.join("\n");
}
