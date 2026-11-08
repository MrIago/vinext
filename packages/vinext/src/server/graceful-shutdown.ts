import type { Server } from "node:http";

/**
 * Graceful SIGINT/SIGTERM handling for the long-running production server.
 *
 * Mirrors Next.js's `startServer` (packages/next/src/server/lib/start-server.ts),
 * which both `next start` and the standalone `server.js` go through:
 *   - `server.close()` stops accepting connections and waits for in-flight
 *     requests (Node also drops idle keep-alive sockets on close).
 *   - Exit with 128 + signal number (130 for SIGINT, 143 for SIGTERM) so
 *     supervisors see a signal termination, not a clean exit.
 *   - Repeated signals are ignored (shells re-send SIGINT on ctrl+c).
 *   - `NEXT_MANUAL_SIG_HANDLE` opts out for apps that install their own.
 *
 * Without handlers, Node either dies immediately on SIGTERM (dropping
 * in-flight requests) or, as PID 1 in a container, ignores it until the
 * orchestrator SIGKILLs it.
 *
 * Only installed by `vinext start` and the standalone entry, never by
 * `startProdServer` itself: prerender and tests start it in-process and
 * must not have the process exit underneath them.
 */
export function installGracefulShutdown(server: Server, proc: NodeJS.Process = process): void {
  if (proc.env.NEXT_MANUAL_SIG_HANDLE) return;

  let cleanupStarted = false;
  const cleanup = (signal: "SIGINT" | "SIGTERM") => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    server.close((err) => {
      if (err) console.error(err);
      proc.exit(signal === "SIGINT" ? 130 : 143);
    });
  };

  proc.on("SIGINT", () => cleanup("SIGINT"));
  proc.on("SIGTERM", () => cleanup("SIGTERM"));
}
