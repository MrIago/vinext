const key = Symbol.for("vinext.test.staticToPartialRevalidated");

export function isStaticToPartialRevalidated(): boolean {
  return (globalThis as Record<symbol, unknown>)[key] === true;
}

export function markStaticToPartialRevalidated(): void {
  (globalThis as Record<symbol, unknown>)[key] = true;
}
