import { NEXTJS_ACTION_NOT_FOUND_HEADER as SERVER_ACTION_NOT_FOUND_HEADER } from "./headers.js";
import { UnrecognizedActionError } from "vinext/shims/unrecognized-action-error";

const SERVER_ACTION_NOT_FOUND_DOCS =
  "https://nextjs.org/docs/messages/failed-to-find-server-action";

/**
 * Like Next.js (vercel/next.js#98123), an unrecognized Server Action is a
 * client error: a malformed id is `400 Invalid Server Action request.`, and a
 * well-formed id this deployment doesn't have (deployment skew) is
 * `409 Server Action unavailable.`.
 *
 * Next.js recognizes an id by its fixed length (`mightBeServerReferenceId`).
 * Every id vinext emits is `<referenceKey>#<exportName>`, as @vitejs/plugin-rsc
 * builds it for `createServerReference`, so the equivalent structural check is
 * a non-empty reference key, one `#`, and an export name that is a JavaScript
 * identifier, with no whitespace or control character in the key.
 */
const MAX_SERVER_ACTION_ID_LENGTH = 4096;
const SERVER_ACTION_EXPORT_NAME_RE = /^[A-Za-z_$][\w$]*$/;

export function isMalformedServerActionId(actionId: string | null): boolean {
  if (actionId === null) return false;
  if (actionId.length > MAX_SERVER_ACTION_ID_LENGTH) return true;
  const hashIndex = actionId.lastIndexOf("#");
  if (hashIndex <= 0) return true;
  const referenceKey = actionId.slice(0, hashIndex);
  const exportName = actionId.slice(hashIndex + 1);
  // oxlint-disable-next-line no-control-regex -- control characters make an id malformed
  if (/[\s\u0000-\u001f\u007f]/.test(referenceKey)) return true;
  return !SERVER_ACTION_EXPORT_NAME_RE.test(exportName);
}

function getUnrecognizedActionStatusCode(actionId: string | null): 400 | 409 {
  return isMalformedServerActionId(actionId) ? 400 : 409;
}

function getUnrecognizedActionResponseBody(statusCode: 400 | 409): string {
  return statusCode === 400 ? "Invalid Server Action request." : "Server Action unavailable.";
}

function getServerActionNotFoundPrefix(actionId: string | null): string {
  return `Failed to find Server Action${actionId ? ` "${actionId}"` : ""}.`;
}

export function getServerActionNotFoundMessage(actionId: string | null): string {
  return `${getServerActionNotFoundPrefix(
    actionId,
  )} This request might be from an older or newer deployment.\nRead more: ${SERVER_ACTION_NOT_FOUND_DOCS}`;
}

function getServerActionNotFoundClientMessage(actionId: string): string {
  return `Server Action "${actionId}" was not found on the server. \nRead more: ${SERVER_ACTION_NOT_FOUND_DOCS}`;
}

function getUnknownMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "";
}

export function isServerActionNotFoundError(error: unknown, actionId: string | null): boolean {
  const message = getUnknownMessage(error);
  if (!message) {
    return false;
  }

  if (actionId && message.startsWith(getServerActionNotFoundPrefix(actionId))) {
    return true;
  }

  if (!actionId && message.startsWith("Failed to find Server Action")) {
    return true;
  }

  // `@vitejs/plugin-rsc` raises two different "no such server reference"
  // errors depending on the build mode. Both mean the same thing — the
  // referenced server action id isn't in the runtime manifest — and must
  // surface as Next.js' 409 (or 400 for a malformed id) + action-not-found header rather than a generic
  // 500. The progressive (no-JS) path also hits this in `decodeAction(body)`
  // before it has any actionId in hand, so match these patterns whether or
  // not the caller has resolved an action id from request headers.
  //
  //  - dev:  `[vite-rsc] invalid server reference '<id>'` (from the reference
  //          validation virtual module loaded ahead of dynamic import)
  //  - prod: `server reference not found '<id>'`         (from the built
  //          `virtual:vite-rsc/server-references` lookup, including the case
  //          where the build has no server actions at all)
  //
  // See: @vitejs/plugin-rsc dist/rsc.js (`server reference not found`) and
  // dist/plugin-*.js (`[vite-rsc] invalid <type> reference`).
  //
  // Action ids resolved from request headers carry the `#<exportName>` suffix
  // (e.g. `/app/foo.ts#bar`), but `loadServerAction(id)` strips that suffix
  // before calling `requireModule(file)`. The dev-mode validator therefore
  // emits the module path WITHOUT the `#<exportName>` — so we also check the
  // pre-`#` portion to match either shape (#1340).
  if (actionId) {
    const moduleId = actionId.split("#")[0];
    if (
      message.includes(`[vite-rsc] invalid server reference '${actionId}'`) ||
      (moduleId &&
        moduleId !== actionId &&
        message.includes(`[vite-rsc] invalid server reference '${moduleId}'`))
    ) {
      return true;
    }
    if (
      message.includes(`server reference not found '${actionId}'`) ||
      (moduleId &&
        moduleId !== actionId &&
        message.includes(`server reference not found '${moduleId}'`))
    ) {
      return true;
    }
    return false;
  }

  return (
    /\[vite-rsc] invalid server reference '/.test(message) ||
    /server reference not found '/.test(message)
  );
}

export function createServerActionNotFoundResponse(actionId: string | null = null): Response {
  const status = getUnrecognizedActionStatusCode(actionId);
  return new Response(getUnrecognizedActionResponseBody(status), {
    status,
    headers: {
      [SERVER_ACTION_NOT_FOUND_HEADER]: "1",
      "content-type": "text/plain",
    },
  });
}

/**
 * Log the unknown action id, clear the request context, and build the 400/409.
 * Shared by action forwarding, action execution, and the RSC handler.
 */
export function respondServerActionNotFound(
  actionId: string | null,
  clearRequestContext: () => void,
): Response {
  console.warn(getServerActionNotFoundMessage(actionId));
  clearRequestContext();
  return createServerActionNotFoundResponse(actionId);
}

function isServerActionNotFoundResponse(response: Pick<Response, "headers">): boolean {
  return response.headers.get(SERVER_ACTION_NOT_FOUND_HEADER) === "1";
}

/**
 * Throw an `UnrecognizedActionError` when the server reported the requested
 * server action id as unknown (the `x-nextjs-action-not-found` response
 * header); otherwise return so the caller can keep processing the response.
 *
 * The client-side counterpart of `createServerActionNotFoundResponse`. The
 * typed error lets client `catch` blocks call the public
 * `unstable_isUnrecognizedActionError` predicate to detect client/server
 * deployment skew and recover (typically by reloading the page).
 *
 * Mirrors Next.js, whose server-action reducer throws `UnrecognizedActionError`
 * on this same response header:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/router-reducer/reducers/server-action-reducer.ts
 */
export function throwOnServerActionNotFound(
  response: Pick<Response, "headers">,
  actionId: string,
): void {
  if (isServerActionNotFoundResponse(response)) {
    throw new UnrecognizedActionError(getServerActionNotFoundClientMessage(actionId));
  }
}
