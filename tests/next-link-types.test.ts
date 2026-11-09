import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import { describe, expect, it } from "vite-plus/test";

async function linkPackage(root: string, packageName: string, target: string): Promise<void> {
  const linkPath = path.join(root, "node_modules", packageName);
  await mkdir(path.dirname(linkPath), { recursive: true });
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

// Ported from Next.js's Partial Prefetching API (vercel/next.js#94510): Link's
// prefetch takes the stage to prefetch to, and router.prefetch() a kind.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/client/app-dir/link.tsx
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/app-router-context.shared-runtime.ts
describe("next/link and router.prefetch consumer types", () => {
  it("accept the Partial Prefetching stages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-link-types-"));
    const api = new API({ cwd: root });
    try {
      await linkPackage(
        root,
        "vinext",
        fileURLToPath(new URL("../packages/vinext", import.meta.url)),
      );
      await linkPackage(
        root,
        "@vinext/types",
        fileURLToPath(new URL("../packages/types", import.meta.url)),
      );
      for (const packageName of ["react", "@types/react"]) {
        await linkPackage(
          root,
          packageName,
          path.dirname(fileURLToPath(import.meta.resolve(`${packageName}/package.json`))),
        );
      }
      // Mirrors the tsconfig.json that create-vinext-app generates.
      await writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2017",
            lib: ["dom", "dom.iterable", "esnext"],
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            module: "esnext",
            moduleResolution: "bundler",
            isolatedModules: true,
            jsx: "preserve",
            types: ["vinext/types"],
          },
          include: ["**/*.tsx"],
        }),
      );
      const file = path.join(root, "page.tsx");
      await writeFile(
        file,
        `"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function Page() {
  const router = useRouter();
  router.prefetch("/a");
  for (const kind of ["auto", "full", "shell", "prefetch", "navigation"] as const) {
    router.prefetch("/a", { kind });
  }
  return (
    <>
      <Link href="/a" prefetch="shell">a</Link>
      <Link href="/a" prefetch="prefetch">a</Link>
      <Link href="/a" prefetch="navigation">a</Link>
      <Link href="/a" prefetch="auto">a</Link>
      <Link href="/a" prefetch={true}>a</Link>
      {/* @ts-expect-error not a stage */}
      <Link href="/a" prefetch="segment">a</Link>
    </>
  );
}
`,
      );

      const snapshot = api.updateSnapshot({ openFiles: [file] });
      try {
        const project = snapshot.getDefaultProjectForFile(file);
        if (!project) throw new Error("Expected a TypeScript project for the consumer page");
        expect(project.program.getSemanticDiagnostics(file).map((d) => d.text)).toEqual([]);
      } finally {
        snapshot.dispose();
      }
    } finally {
      api.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});
