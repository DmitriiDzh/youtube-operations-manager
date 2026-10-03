import { AsyncLocalStorage } from "node:async_hooks";

// BL-117 -- which piece of work the current API calls belong to (a batch run, Fix all, a sync, ...). Kept on
// `globalThis` under a `Symbol.for` key: Next.js bundles the route handlers, `after()` bodies and the gateway
// separately, and a module-level instance would be a different object in each (the BL-116 lesson: state written
// through one copy was invisible to another).

export type QuotaContext = {
  /** `batch`, `fix_all`, `channel_sync`, `analytics_collection`, `research_collection`, ... */
  kind: string;
  /** The operation's own id (a batch id, an operation id); `null` when the work has none. */
  id: string | null;
  /** Human-readable, no secrets. */
  label: string;
};

const KEY = Symbol.for("ytom.quota.context");
type GlobalWithContext = typeof globalThis & { [KEY]?: AsyncLocalStorage<QuotaContext> };

function storage(): AsyncLocalStorage<QuotaContext> {
  const g = globalThis as GlobalWithContext;
  return (g[KEY] ??= new AsyncLocalStorage<QuotaContext>());
}

/** Runs `fn`; every YouTube API call made inside it (including awaited and concurrent ones) is attributed to `context`. */
export function runWithQuotaContext<T>(context: QuotaContext, fn: () => T): T {
  return storage().run(context, fn);
}

export function currentQuotaContext(): QuotaContext | null {
  return storage().getStore() ?? null;
}

/** `fn`, but every call to it runs inside `context` (for facades that scope a service method to one kind of work). */
export function quotaScoped<A extends unknown[], R>(fn: (...args: A) => R, context: QuotaContext): (...args: A) => R {
  return (...args: A) => runWithQuotaContext(context, () => fn(...args));
}
