import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isPidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Captures OS-level creation ticks (Windows) or start time string (POSIX)
 * so later cancel/liveness checks never mistake a recycled OS PID (e.g. OneDrive)
 * for our worker or ZCode process.
 */
export async function getProcessStartTicks(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks }`,
        ],
        { timeout: 5000, windowsHide: true },
      );
      const trimmed = stdout.trim();
      return /^\d+$/.test(trimmed) ? trimmed : null;
    }
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5000 });
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

export async function isVerifiedProcessAlive(
  pid: number | null | undefined,
  expectedStartTicks: string | null | undefined,
): Promise<{ alive: boolean; pidReused: boolean }> {
  if (!isPidAlive(pid) || !pid) return { alive: false, pidReused: false };
  if (!expectedStartTicks) return { alive: true, pidReused: false };
  const currentTicks = await getProcessStartTicks(pid);
  if (!currentTicks) return { alive: false, pidReused: false };
  if (currentTicks !== expectedStartTicks) return { alive: false, pidReused: true };
  return { alive: true, pidReused: false };
}

export async function killVerifiedProcessTree(
  pid: number | null | undefined,
  expectedStartTicks: string | null | undefined,
): Promise<{ status: "already_exited" | "pid_reused" | "killed" | "kill_failed"; error?: string }> {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return { status: "already_exited" };
  const check = await isVerifiedProcessAlive(pid, expectedStartTicks);
  if (check.pidReused) return { status: "pid_reused" };
  if (!check.alive) return { status: "already_exited" };

  try {
    if (process.platform === "win32") {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        timeout: 10000,
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
    return { status: "killed" };
  } catch (err) {
    if (!isPidAlive(pid)) return { status: "already_exited" };
    return { status: "kill_failed", error: err instanceof Error ? err.message : String(err) };
  }
}
