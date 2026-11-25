import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getProcessStartTicks, isPidAlive, isVerifiedProcessAlive, killVerifiedProcessTree } from "./process-identity.js";

describe("process-identity", () => {
  it("verifies live process with matching start ticks and rejects recycled PID ticks", async () => {
    assert.equal(isPidAlive(process.pid), true);
    const ticks = await getProcessStartTicks(process.pid);
    assert.ok(ticks && ticks.length > 0);

    const exact = await isVerifiedProcessAlive(process.pid, ticks);
    assert.deepEqual(exact, { alive: true, pidReused: false });

    const fakeTicks = `${ticks}999`;
    const reused = await isVerifiedProcessAlive(process.pid, fakeTicks);
    assert.deepEqual(reused, { alive: false, pidReused: true });

    const killRefused = await killVerifiedProcessTree(process.pid, fakeTicks);
    assert.equal(killRefused.status, "pid_reused");
    assert.equal(isPidAlive(process.pid), true);
  });

  it("reports already_exited for invalid or dead PIDs", async () => {
    const res = await killVerifiedProcessTree(999_999_999, "123456");
    assert.equal(res.status, "already_exited");
  });
});
