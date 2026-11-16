import { rm as remove } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

type Flushable = { flush(): Promise<void> };
const stores = new Map<Flushable, string>();

/** Only for shutdown tests whose deliberately stuck fake can never touch the filesystem. */
export function discardFakeStore(store: Flushable): void { stores.delete(store); }

/** Register every instance, including reopened stores and stores in subdirectories. */
export function trackPersistence<T extends Flushable>(directory: string, store: T): T {
  stores.set(store, resolve(directory));
  return store;
}

/** Construct a store without losing its concrete type or evaluating its arguments twice. */
export function testStore<A extends [string, ...any[]], T extends Flushable | { store: Flushable }>(
  Store: new (...args: A) => T, ...args: A
): T {
  const store = new Store(...args);
  trackPersistence(args[0], "store" in store ? store.store : store);
  return store;
}

/** Same interface as fs.rm; only removal of a writer's directory drains that writer. */
export const rm: typeof remove = async (path, options) => {
  if (options?.recursive) {
    const directory = resolve(String(path));
    const owned = [...stores].filter(([, child]) => {
      const rest = relative(directory, child);
      return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
    });
    // Sequential: multiple stores can write the same file when a test simulates a restart.
    for (const [store] of owned) await store.flush();
    await remove(path, options);
    for (const [store] of owned) stores.delete(store);
    return;
  }
  await remove(path, options);
};
