// A stand-in for the previous worker (tests/worker-lock.test.ts): named like Paseo's plugin process, so the lock's
// owner check counts it. It takes worker.lock, keeps it for `holdMs`, and exits without releasing it, as a worker the
// host killed would. With "-" for the lock it takes nothing: another plugin's worker that got a reused pid.
import { writeFileSync } from "node:fs";
const [lock, holdMs = "2000"] = process.argv.slice(2);
if (lock !== "-") writeFileSync(lock, `${process.pid}:previous-worker`);
process.stdout.write("locked\n");
setTimeout(() => process.exit(0), Number(holdMs));
