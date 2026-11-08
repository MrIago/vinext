/**
 * Build the target for a Proxy that stands in for a Headers object.
 *
 * Node's util.inspect unwraps a Proxy and calls the target's
 * `[nodejs.util.inspect.custom]` with the *proxy* as `this`. With a real
 * Headers as the target that is undici's method, whose `this.#headersList`
 * brand check throws on the proxy. This is not hypothetical: inspecting any
 * promise prints its AsyncLocalStorage store, so app code doing
 * `console.log(new Promise(() => {}))` reaches the request context and the
 * throw aborts module evaluation, failing every page.
 *
 * The target is therefore an empty object with the Headers prototype (so
 * `instanceof Headers` still holds) and an own inspect hook that prints the
 * real Headers the proxy currently reads from. The proxy's `get` trap must read
 * from that source, never from this target.
 */
export function headersProxyTarget(getSource: () => Headers): Headers {
  const target = Object.create(Headers.prototype) as Headers;
  Object.defineProperty(target, Symbol.for("nodejs.util.inspect.custom"), {
    value: (_depth: number, options: object, inspect: (value: unknown, opts: object) => string) =>
      inspect(getSource(), options),
  });
  return target;
}
