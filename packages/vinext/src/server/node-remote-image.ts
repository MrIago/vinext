/**
 * Fetch a remote `/_next/image` source on the Node.js server, guarded like
 * Next.js' fetchExternalImage against SSRF and DNS rebinding.
 *
 * Every address the hostname resolves to is checked before connecting, and
 * the socket is pinned to exactly those addresses, so a record that changes
 * between the check and the connection (DNS rebinding) cannot reach a private
 * network. Literal IPs are checked as-is. Redirects are followed by the same
 * function, so each hop is resolved, checked and pinned again. Responses are
 * capped at `images.maximumResponseBody`, bodies are decoded by hand (with a
 * bounded number of content codings) and the request times out after 7s.
 *
 * Workers cannot pin a `fetch()` to a resolved address, so this is Node-only.
 *
 * Ported from Next.js: packages/next/src/server/image-optimizer.ts
 * (fetchExternalImage, createPinnedLookup, requestUpstreamImage).
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/image-optimizer.ts
 */

import { createHash } from "node:crypto";
import { ADDRCONFIG, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { pipeline, type Readable, Transform, type TransformCallback } from "node:stream";
import {
  constants as zlibConstants,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createInflateRaw,
} from "node:zlib";
import { isPrivateIp } from "vinext/shims/image-config";

/** An error answered with its status, like Next.js' ImageError. */
export class RemoteImageError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export type RemoteImage = {
  buffer: Buffer;
  contentType: string | undefined;
  cacheControl: string | undefined;
  etag: string;
};

type LookupFunction = (
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

const INVALID_UPSTREAM = '"url" parameter is valid but upstream response is invalid';
const REQUEST_TIMEOUT = 7_000;
const agentOptions = { keepAlive: true, timeout: REQUEST_TIMEOUT };

type ImageRequestOptions = RequestOptions & { imageLookupKey?: string };
type AgentGetName = (options?: RequestOptions) => string;
const getHttpAgentName = (HttpAgent.prototype as HttpAgent & { getName: AgentGetName }).getName;
const getHttpsAgentName = (HttpsAgent.prototype as HttpsAgent & { getName: AgentGetName }).getName;

/** Pools sockets per validated address set, never across different sets. */
class ImageHttpAgent extends HttpAgent {
  getName(options: ImageRequestOptions = {}): string {
    return `${getHttpAgentName.call(this, options)}:${options.imageLookupKey ?? ""}`;
  }
}

class ImageHttpsAgent extends HttpsAgent {
  getName(options: ImageRequestOptions = {}): string {
    return `${getHttpsAgentName.call(this, options)}:${options.imageLookupKey ?? ""}`;
  }
}

const agents = new Map<string, HttpAgent>();

/** Protected and permissive (dangerouslyAllowLocalIP) requests never share sockets. */
function getImageAgent(dangerouslyAllowLocalIP: boolean, isHttps: boolean): HttpAgent {
  const key = `${dangerouslyAllowLocalIP}:${isHttps}`;
  let agent = agents.get(key);
  if (!agent) {
    agent = isHttps ? new ImageHttpsAgent(agentOptions) : new ImageHttpAgent(agentOptions);
    agents.set(key, agent);
  }
  return agent;
}

const BASE_REQ_HEADERS = {
  accept: "*/*",
  "accept-language": "*",
  "sec-fetch-mode": "cors",
  "user-agent": "node",
};
const HTTP_FETCH_HEADERS = { ...BASE_REQ_HEADERS, "accept-encoding": "gzip, deflate" };
const HTTPS_FETCH_HEADERS = { ...BASE_REQ_HEADERS, "accept-encoding": "br, gzip, deflate" };

/**
 * Resolve `hostname` with the DNS options the socket itself would use, so the
 * addresses checked are the exact set the connection can reach.
 */
function lookupAsSocketWould(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, {
    all: true,
    hints: process.platform === "win32" ? 0 : ADDRCONFIG,
  });
}

/**
 * Pin the connection to `addresses` instead of letting it resolve `hostname`
 * a second time. Every address was checked, so all are handed back to keep
 * Node's happy eyeballs failover between IPv6 and IPv4.
 */
export function createPinnedLookup(hostname: string, addresses: LookupAddress[]): LookupFunction {
  return (lookupHostname, options, callback) => {
    if (lookupHostname !== hostname) {
      callback(
        new Error(
          `Image lookup hostname "${lookupHostname}" does not match request hostname "${hostname}"`,
        ),
        [],
      );
      return;
    }
    const family = typeof options.family === "number" ? options.family : 0;
    const matched = family ? addresses.filter((address) => address.family === family) : addresses;
    if (matched.length === 0) {
      // Node destructures the first address, so an empty list would throw
      // inside the socket and escape the request.
      const error: NodeJS.ErrnoException = new Error(
        `No IPv${family} address available for ${hostname}`,
      );
      error.code = "ENODATA";
      callback(error, []);
      return;
    }
    if (options.all) {
      callback(null, matched);
    } else {
      callback(null, matched[0].address, matched[0].family);
    }
  };
}

function requestUpstreamImage(
  url: URL,
  pinnedLookup: LookupFunction | undefined,
  imageLookupKey: string | undefined,
  dangerouslyAllowLocalIP: boolean,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const options: ImageRequestOptions = {
      agent: getImageAgent(dangerouslyAllowLocalIP, isHttps),
      headers: isHttps ? HTTPS_FETCH_HEADERS : HTTP_FETCH_HEADERS,
      imageLookupKey,
      lookup: pinnedLookup,
      signal,
    };
    const request = (isHttps ? httpsRequest : httpRequest)(url, options, resolve);
    request.on("error", reject);
    request.end();
  });
}

/** Inflate a zlib-wrapped or raw deflate body, which servers send either way. */
class DeflateDecoder extends Transform {
  private decoder: Transform | undefined;

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    if (!this.decoder) {
      if (chunk.length === 0) {
        callback();
        return;
      }
      const options = {
        flush: zlibConstants.Z_SYNC_FLUSH,
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
      };
      this.decoder =
        (chunk[0] & 0x0f) === 0x08 ? createInflate(options) : createInflateRaw(options);
      this.decoder.on("data", (data: Buffer) => this.push(data));
      this.decoder.on("end", () => this.push(null));
      this.decoder.on("error", (error) => this.destroy(error));
    }
    this.decoder.write(chunk, encoding, callback);
  }

  _final(callback: TransformCallback): void {
    this.decoder?.end();
    this.decoder = undefined;
    callback();
  }
}

/** The chain limit of native fetch (undici). */
const MAX_CONTENT_ENCODINGS = 5;

function decodeResponseBody(response: IncomingMessage): Readable {
  const contentEncoding = response.headers["content-encoding"];
  if (!contentEncoding) return response;
  const codings = contentEncoding.toLowerCase().split(",");
  if (codings.length > MAX_CONTENT_ENCODINGS) {
    throw new RemoteImageError(400, INVALID_UPSTREAM);
  }
  const decoders: Transform[] = [];
  for (let i = codings.length - 1; i >= 0; i--) {
    switch (codings[i].trim()) {
      case "x-gzip":
      case "gzip":
        decoders.push(
          createGunzip({
            flush: zlibConstants.Z_SYNC_FLUSH,
            finishFlush: zlibConstants.Z_SYNC_FLUSH,
          }),
        );
        break;
      case "deflate":
        decoders.push(new DeflateDecoder());
        break;
      case "br":
        decoders.push(
          createBrotliDecompress({
            flush: zlibConstants.BROTLI_OPERATION_FLUSH,
            finishFlush: zlibConstants.BROTLI_OPERATION_FLUSH,
          }),
        );
        break;
      default:
        return response;
    }
  }
  pipeline([response, ...decoders], () => {});
  return decoders[decoders.length - 1];
}

function getHash(items: ReadonlyArray<string | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const item of items) hash.update(item);
  return hash.digest("base64url");
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

export type FetchRemoteImageOptions = {
  dangerouslyAllowLocalIP: boolean;
  maximumResponseBody: number;
  /** `images.maximumRedirects`. */
  maximumRedirects: number;
  /** DNS resolution, replaceable in tests. */
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
};

/**
 * Fetch a remote image source. `href` already matched `images.remotePatterns`;
 * as in Next.js, redirect targets are not matched again, but every hop's
 * addresses are.
 */
export async function fetchRemoteImage(
  href: string,
  options: FetchRemoteImageOptions,
  count = options.maximumRedirects,
): Promise<RemoteImage> {
  const url = new URL(href);
  // `URL.hostname` keeps the brackets around an IPv6 literal, the socket does not.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let pinnedLookup: LookupFunction | undefined;
  let imageLookupKey: string | undefined;

  if (!options.dangerouslyAllowLocalIP) {
    const literalFamily = isIP(hostname);
    let addresses: LookupAddress[];
    if (literalFamily > 0) {
      addresses = [{ address: hostname, family: literalFamily }];
    } else {
      addresses = await (options.lookup ?? lookupAsSocketWould)(hostname);
      pinnedLookup = createPinnedLookup(hostname, addresses);
    }
    imageLookupKey = addresses.map((address) => `${address.family}:${address.address}`).join(",");
    const privateIps = addresses.map((record) => record.address).filter((ip) => isPrivateIp(ip));
    if (privateIps.length > 0) {
      console.error(
        `[vinext] upstream image ${href} hostname resolved to private IP ${JSON.stringify(privateIps)}. ` +
          "If this is expected and you understand SSRF risk, use images.dangerouslyAllowLocalIP = true to continue.",
      );
      throw new RemoteImageError(400, '"url" parameter is not allowed');
    }
  }

  const signal = AbortSignal.timeout(REQUEST_TIMEOUT);
  const timedOut = () =>
    new RemoteImageError(504, '"url" parameter is valid but upstream response timed out');
  let response: IncomingMessage;
  try {
    response = await requestUpstreamImage(
      url,
      pinnedLookup,
      imageLookupKey,
      options.dangerouslyAllowLocalIP,
      signal,
    );
  } catch (error) {
    if (signal.aborted) throw timedOut();
    throw error;
  }

  const status = response.statusCode ?? 0;
  const location = response.headers.location;
  if (isRedirectStatus(status) && location && URL.canParse(location, href)) {
    // A redirect body is never used, and draining it would download without
    // the maximumResponseBody limit.
    response.destroy();
    if (count === 0) {
      throw new RemoteImageError(508, INVALID_UPSTREAM);
    }
    return fetchRemoteImage(new URL(location, href).href, options, count - 1);
  }

  if (status < 200 || status > 299) {
    response.destroy();
    throw new RemoteImageError(status || 500, INVALID_UPSTREAM);
  }

  const chunks: Buffer[] = [];
  let totalSize = 0;
  try {
    for await (const chunk of decodeResponseBody(response) as AsyncIterable<Buffer>) {
      totalSize += chunk.byteLength;
      if (totalSize > options.maximumResponseBody) {
        throw new RemoteImageError(413, INVALID_UPSTREAM);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    response.destroy();
    if (signal.aborted) throw timedOut();
    throw error;
  }
  if (totalSize === 0) throw new RemoteImageError(400, INVALID_UPSTREAM);

  const buffer = Buffer.concat(chunks);
  const upstreamEtag = response.headers.etag;
  return {
    buffer,
    contentType: response.headers["content-type"],
    cacheControl: response.headers["cache-control"],
    etag: upstreamEtag ? Buffer.from(upstreamEtag).toString("base64url") : getHash([buffer]),
  };
}
