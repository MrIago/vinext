import localFont from "next/font/local";

// Declared in its own module, the way Next.js's with-font-declarations-file
// fixture does, so the layout imports no stylesheet of its own for it.
export const declaredFont = localFont({ src: "./local.woff2", variable: "--font-declared" });
