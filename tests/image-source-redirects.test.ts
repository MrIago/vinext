import { describe, expect, it } from "vitest";
import { fetchImageSourceFollowingRedirects } from "../packages/vinext/src/server/image-optimization.js";

// Ported from Next.js `fetchInternalImage` redirect handling
// (vercel/next.js#100005, issue cloudflare/vinext#4564).
function redirect(location: string, status = 307): Response {
  return new Response(null, { status, headers: { Location: location } });
}

describe("fetchImageSourceFollowingRedirects", () => {
  const request = new Request("https://app.example/_next/image?url=%2Fa.png&w=64&q=75");

  it("follows a relative redirect through the internal fetch", async () => {
    const seen: string[] = [];
    const response = await fetchImageSourceFollowingRedirects(
      {
        fetchAsset: async (path) => {
          seen.push(path);
          return path === "/a.png" ? redirect("/images/a.png") : new Response("png");
        },
      },
      "/a.png",
      request,
      3,
    );
    expect(seen).toEqual(["/a.png", "/images/a.png"]);
    expect(await response.text()).toBe("png");
  });

  it("stops at maximumRedirects", async () => {
    let calls = 0;
    const response = await fetchImageSourceFollowingRedirects(
      {
        fetchAsset: async () => {
          calls++;
          return redirect("/loop.png");
        },
      },
      "/a.png",
      request,
      2,
    );
    expect(calls).toBe(3);
    expect(response.status).toBe(307);
  });

  it("does not follow an absolute redirect without remote fetching", async () => {
    const seen: string[] = [];
    const response = await fetchImageSourceFollowingRedirects(
      {
        fetchAsset: async (path) => {
          seen.push(path);
          return redirect("https://cdn.example/a.png");
        },
      },
      "/a.png",
      request,
      3,
    );
    expect(seen).toEqual(["/a.png"]);
    expect(response.status).toBe(307);
  });

  it("follows an absolute redirect where remote sources are allowed", async () => {
    const seen: string[] = [];
    await fetchImageSourceFollowingRedirects(
      {
        allowRemote: true,
        fetchAsset: async (path) => {
          seen.push(path);
          return path === "/a.png" ? redirect("https://cdn.example/a.png") : new Response("png");
        },
      },
      "/a.png",
      request,
      3,
    );
    expect(seen).toEqual(["/a.png", "https://cdn.example/a.png"]);
  });
});
