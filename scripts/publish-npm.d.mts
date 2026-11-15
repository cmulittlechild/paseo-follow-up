export const VERIFY_TIMEOUT_MS: number;
export const POLL_INTERVAL_MS: number;
export class PublicationError extends Error { code: string; constructor(code: string, message: string); }
type Package = { name: string; version: string };
type RegistryDocument = { dist?: { integrity?: string }; [key: string]: unknown };
type Deps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
  log?: (message: string) => void;
  output?: (stdout?: string, stderr?: string) => void;
  read?: (path: string, timeoutMs?: number) => Promise<RegistryDocument | null>;
  fetch?: typeof globalThis.fetch;
  npm?: (args: string[]) => { status: number | null; stdout?: string; stderr?: string };
};
export function registryJson(path: string, deps?: Pick<Deps, "fetch" | "now"> & { timeoutMs?: number }): Promise<RegistryDocument | null>;
export function waitForPublication(pkg: Package, integrity: string, distTag: string, deps?: Deps): Promise<void>;
export function publishPackage(pkg: Package, deps?: Deps): Promise<void>;
