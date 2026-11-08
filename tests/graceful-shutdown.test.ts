// Ported from Next.js: test/production/graceful-shutdown/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/production/graceful-shutdown/index.test.ts
//
// `next start` and the standalone `server.js` register SIGINT/SIGTERM
// handlers (packages/next/src/server/lib/start-server.ts) that stop
// accepting new connections, let in-flight requests finish, then exit with
// 128 + signal number. NEXT_MANUAL_SIG_HANDLE opts out.
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installGracefulShutdown } from "../packages/vinext/src/server/graceful-shutdown.js";

const LONG_RUNNING_MS = 400;

class FakeProcess extends EventEmitter {
  env: Record<string, string | undefined> = {};
  exitCode: number | undefined;
  exit: (code: number) => void = () => {};
  exited = new Promise<number>((resolve) => {
    this.exit = (code: number) => {
      this.exitCode = code;
      resolve(code);
    };
  });
}

let server: http.Server | undefined;

afterEach(async () => {
  if (server?.listening) await new Promise((r) => server!.close(() => r(undefined)));
  server = undefined;
});

async function startServer() {
  server = http.createServer((req, res) => {
    const delay = req.url === "/long-running" ? LONG_RUNNING_MS : 0;
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ hello: "world" }));
    }, delay);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

function asProcess(proc: FakeProcess) {
  return proc as unknown as NodeJS.Process;
}

describe("installGracefulShutdown", () => {
  it("finishes pending requests, refuses new ones, exits 143 on SIGTERM", async () => {
    const port = await startServer();
    const proc = new FakeProcess();
    installGracefulShutdown(server!, asProcess(proc));

    // `connection: close` like Next's `fetchViaHTTPClose`: otherwise the
    // finished keep-alive socket holds `server.close()` open until the
    // client's idle timeout, in Next and here alike.
    const pending = fetch(`http://127.0.0.1:${port}/long-running`, {
      headers: { connection: "close" },
    });
    await new Promise((r) => setTimeout(r, 50));
    proc.emit("SIGTERM");

    const refused = await fetch(`http://127.0.0.1:${port}/fast`, {
      headers: { connection: "close" },
    }).then(
      () => null,
      (e: { cause?: { code?: string } }) => e,
    );
    expect(refused?.cause?.code).toBe("ECONNREFUSED");
    expect(proc.exitCode).toBeUndefined();

    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });
    expect(await proc.exited).toBe(143);
  });

  it("exits 130 on SIGINT and ignores duplicate signals", async () => {
    await startServer();
    const proc = new FakeProcess();
    const exit = vi.spyOn(proc, "exit");
    installGracefulShutdown(server!, asProcess(proc));

    proc.emit("SIGINT");
    proc.emit("SIGINT");
    proc.emit("SIGTERM");
    expect(await proc.exited).toBe(130);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("registers nothing when NEXT_MANUAL_SIG_HANDLE is set", async () => {
    await startServer();
    const proc = new FakeProcess();
    proc.env.NEXT_MANUAL_SIG_HANDLE = "true";
    installGracefulShutdown(server!, asProcess(proc));
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    expect(proc.listenerCount("SIGINT")).toBe(0);
  });
});
