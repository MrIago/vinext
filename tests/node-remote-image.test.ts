import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { LookupAddress, LookupOptions } from "node:dns";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import type { ParseImageParamsOptions } from "../packages/vinext/src/server/image-optimization.js";

vi.mock("../packages/vinext/src/shims/image-config.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../packages/vinext/src/shims/image-config.js")>();
  return { ...actual, isPrivateIp: vi.fn(actual.isPrivateIp) };
});

const imageConfig = await import("../packages/vinext/src/shims/image-config.js");
const actualIsPrivateIp = (
  await vi.importActual<typeof import("../packages/vinext/src/shims/image-config.js")>(
    "../packages/vinext/src/shims/image-config.js",
  )
).isPrivateIp;
const { createPinnedLookup, fetchRemoteImage, RemoteImageError } =
  await import("../packages/vinext/src/server/node-remote-image.js");

// Ported from Next.js: test/unit/image-optimizer/create-pinned-lookup.test.ts
// https://github.com/vercel/next.js/blob/canary/test/unit/image-optimizer/create-pinned-lookup.test.ts
describe("createPinnedLookup", () => {
  const HOSTNAME = "example.com";
  const IPV4: LookupAddress = { address: "93.184.216.34", family: 4 };
  const IPV6: LookupAddress = { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 };

  function callLookup(
    options: LookupOptions,
    {
      hostname = HOSTNAME,
      addresses = [IPV4, IPV6],
    }: { hostname?: string; addresses?: LookupAddress[] } = {},
  ) {
    const calls: Array<{
      err: NodeJS.ErrnoException | null;
      result: string | LookupAddress[];
      family?: number;
    }> = [];
    createPinnedLookup(HOSTNAME, addresses)(hostname, options, (err, result, family) =>
      calls.push({ err, result, family }),
    );
    expect(calls).toHaveLength(1);
    return calls[0];
  }

  it("hands back every pinned address for the options a socket uses", () => {
    const { err, result } = callLookup({ all: true });
    expect(err).toBeNull();
    expect(result).toEqual([IPV4, IPV6]);
  });

  it("reports ENODATA rather than an empty list when the family matches nothing", () => {
    const { err, result } = callLookup({ all: true, family: 6 }, { addresses: [IPV4] });
    expect(err?.code).toBe("ENODATA");
    expect(result).toEqual([]);
    expect(callLookup({ family: 6 }, { addresses: [IPV4] }).err?.code).toBe("ENODATA");
  });

  it("returns a single address of the requested family", () => {
    const { err, result, family } = callLookup({ family: 6 });
    expect(err).toBeNull();
    expect({ result, family }).toEqual({ result: IPV6.address, family: 6 });
  });

  it("refuses to resolve a hostname other than the pinned one", () => {
    const { err } = callLookup({ all: true }, { hostname: "attacker.example" });
    expect(err?.message).toContain("does not match request hostname");
  });
});

// Ported from Next.js: test/unit/image-optimizer/fetch-external-image.test.ts
// https://github.com/vercel/next.js/blob/canary/test/unit/image-optimizer/fetch-external-image.test.ts
describe("fetchRemoteImage", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
  let server: Server;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  let requests: string[];
  const port = () => (server.address() as AddressInfo).port;
  const origin = () => `http://127.0.0.1:${port()}`;
  const options = (overrides: Partial<Parameters<typeof fetchRemoteImage>[1]> = {}) => ({
    dangerouslyAllowLocalIP: false,
    maximumResponseBody: 50_000_000,
    maximumRedirects: 3,
    ...overrides,
  });
  const loopback = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
  const isPrivateIp = vi.mocked(imageConfig.isPrivateIp);

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.on("error", () => {});
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=60" });
      res.end(JPEG);
    };
  });

  afterEach(() => {
    loopback.mockClear();
    isPrivateIp.mockReset().mockImplementation(actualIsPrivateIp);
  });

  const rejection = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);

  it("rejects a literal private IP without connecting", async () => {
    const error = await rejection(fetchRemoteImage(`${origin()}/private.jpg`, options()));
    expect(error).toBeInstanceOf(RemoteImageError);
    expect(error).toMatchObject({ statusCode: 400, message: '"url" parameter is not allowed' });
    expect(requests).toHaveLength(0);
  });

  it("rejects a hostname that resolves to a private IP without connecting", async () => {
    const error = await rejection(
      fetchRemoteImage(
        "http://internal.invalid/private.jpg",
        options({ lookup: async () => [{ address: "10.0.0.1", family: 4 }] }),
      ),
    );
    expect(error).toMatchObject({ statusCode: 400, message: '"url" parameter is not allowed' });
    expect(requests).toHaveLength(0);
  });

  it("allows a private IP under dangerouslyAllowLocalIP", async () => {
    const image = await fetchRemoteImage(
      `${origin()}/private.jpg`,
      options({ dangerouslyAllowLocalIP: true }),
    );
    expect(image.buffer).toEqual(JPEG);
    expect(image.contentType).toBe("image/jpeg");
    expect(image.cacheControl).toBe("max-age=60");
    expect(requests).toEqual(["/private.jpg"]);
  });

  it("connects to the address that was checked instead of resolving again", async () => {
    // `.invalid` never resolves, so the request can only succeed if the socket
    // uses the address the private-IP check already approved.
    isPrivateIp.mockReturnValueOnce(false);
    let host: string | undefined;
    handler = (req, res) => {
      host = req.headers.host;
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(JPEG);
    };
    const image = await fetchRemoteImage(
      `http://pinned.invalid:${port()}/pinned.jpg`,
      options({ lookup: loopback }),
    );
    expect(image.buffer).toEqual(JPEG);
    expect(requests).toEqual(["/pinned.jpg"]);
    expect(loopback).toHaveBeenCalledTimes(1);
    expect(host).toBe(`pinned.invalid:${port()}`);
  });

  it("rejects a redirect to a private address (rebinding through a redirect)", async () => {
    isPrivateIp.mockReturnValueOnce(false);
    handler = (_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${port()}/internal.jpg` });
      res.end();
    };
    const error = await rejection(
      fetchRemoteImage(`http://public.invalid:${port()}/redirect`, options({ lookup: loopback })),
    );
    expect(error).toMatchObject({ statusCode: 400, message: '"url" parameter is not allowed' });
    expect(requests).toEqual(["/redirect"]);
  });

  it("follows a redirect and stops after images.maximumRedirects", async () => {
    handler = (req, res) => {
      if (req.url === "/final.jpg") {
        res.writeHead(200, { "content-type": "image/jpeg" });
        res.end(JPEG);
        return;
      }
      res.writeHead(301, { location: req.url === "/once" ? "/final.jpg" : "/loop" });
      res.end();
    };
    const allow = options({ dangerouslyAllowLocalIP: true });
    expect((await fetchRemoteImage(`${origin()}/once`, allow)).buffer).toEqual(JPEG);
    const error = await rejection(
      fetchRemoteImage(`${origin()}/loop`, { ...allow, maximumRedirects: 1 }),
    );
    expect(error).toMatchObject({
      statusCode: 508,
      message: '"url" parameter is valid but upstream response is invalid',
    });
  });

  it("decodes a compressed body and enforces maximumResponseBody on the decoded bytes", async () => {
    const body = Buffer.alloc(64, 1);
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip" });
      res.end(gzipSync(body));
    };
    const allow = options({ dangerouslyAllowLocalIP: true });
    expect((await fetchRemoteImage(`${origin()}/gzip`, allow)).buffer).toEqual(body);
    const error = await rejection(
      fetchRemoteImage(`${origin()}/gzip`, { ...allow, maximumResponseBody: 63 }),
    );
    expect(error).toMatchObject({ statusCode: 413 });
  });

  it("answers an upstream error with its status", async () => {
    handler = (_req, res) => {
      res.writeHead(404);
      res.end("missing");
    };
    const error = await rejection(
      fetchRemoteImage(`${origin()}/missing.jpg`, options({ dangerouslyAllowLocalIP: true })),
    );
    expect(error).toMatchObject({
      statusCode: 404,
      message: '"url" parameter is valid but upstream response is invalid',
    });
  });
});

// Ported from Next.js: validateUrlParam in packages/next/src/server/image-optimizer.ts,
// as covered by test/unit/image-optimizer/match-remote-pattern.test.ts.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/image-optimizer.ts
describe("remote /_next/image sources", () => {
  it("are accepted only where the host fetches them and a pattern allows them", async () => {
    const { parseImageParams } =
      await import("../packages/vinext/src/server/image-optimization.js");
    const parse = (source: string, remote?: ParseImageParamsOptions["remote"]) => {
      const url = new URL("http://localhost/_next/image");
      url.searchParams.set("url", source);
      url.searchParams.set("w", "64");
      url.searchParams.set("q", "75");
      return parseImageParams(url, undefined, undefined, { remote });
    };
    const remote = { remotePatterns: [{ protocol: "https", hostname: "images.example.com" }] };
    expect(parse("https://images.example.com/a.png", remote)?.imageUrl).toBe(
      "https://images.example.com/a.png",
    );
    expect(parse("https://images.example.com/a.png")).toBeNull();
    expect(parse("https://evil.example.com/a.png", remote)).toBeNull();
    expect(parse("http://images.example.com/a.png", remote)).toBeNull();
    expect(parse("ftp://images.example.com/a.png", remote)).toBeNull();
    expect(parse("//images.example.com/a.png", remote)).toBeNull();
    expect(
      parse("https://legacy.example.com/a.png", { domains: ["legacy.example.com"] })?.imageUrl,
    ).toBe("https://legacy.example.com/a.png");
  });
});
