import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ZCodeRuntimePaths } from "../types.js";

const WINDOWS_OS_ENV_KEYS = new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
]);

const POSIX_OS_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
]);

export function normalizeFsPath(targetPath: string): string {
  const cleaned = path.resolve(targetPath.trim()).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? cleaned.toLowerCase() : cleaned;
}

export function resolveUserHome(env: NodeJS.ProcessEnv = process.env): string {
  const homeRaw = env["HOME"]?.trim();
  if (process.platform !== "win32") {
    return path.resolve(homeRaw || env["USERPROFILE"]?.trim() || homedir());
  }
  const userProfile = env["USERPROFILE"]?.trim();
  if (homeRaw && userProfile && normalizeFsPath(homeRaw) === normalizeFsPath(userProfile)) {
    return path.resolve(homeRaw);
  }
  return path.resolve(userProfile || homeRaw || homedir());
}

export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["ZCODE_WORKER_MCP_DATA_DIR"]?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(resolveUserHome(env), ".zcode-worker-mcp");
}

export function resolveZCodeDataPaths(env: NodeJS.ProcessEnv = process.env): {
  userHome: string;
  zcodeDataDir: string;
  cliDbPath: string;
  tasksIndexPath: string;
  personalConfigFile: string;
} {
  const userHome = resolveUserHome(env);
  const explicitZCodeHome = env["ZCODE_HOME"]?.trim();
  let zcodeDataDir: string;
  if (explicitZCodeHome) {
    zcodeDataDir = path.resolve(explicitZCodeHome);
  } else {
    const explicitBase = env["ZCODE_DATA_BASE_DIR"]?.trim();
    const settingBase = readSettingDataBaseDir(userHome);
    const dataBase = explicitBase || settingBase || userHome;
    zcodeDataDir = path.join(path.resolve(dataBase), ".zcode");
  }
  const personalOverride = env["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"]?.trim();
  return {
    userHome,
    zcodeDataDir,
    cliDbPath: path.join(zcodeDataDir, "cli", "db", "db.sqlite"),
    tasksIndexPath: path.join(zcodeDataDir, "v2", "tasks-index.sqlite"),
    personalConfigFile: personalOverride
      ? path.resolve(personalOverride)
      : path.join(zcodeDataDir, "v2", "provider_config.json"),
  };
}

function readSettingDataBaseDir(userHome: string): string | null {
  const settingPath = path.join(userHome, ".zcode", "v2", "setting.json");
  if (!existsSync(settingPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(settingPath, "utf8")) as { dataBaseDir?: unknown };
    const dir = typeof parsed?.dataBaseDir === "string" ? parsed.dataBaseDir.trim() : "";
    return dir && path.isAbsolute(dir) ? dir : null;
  } catch {
    return null;
  }
}

function candidateInstallRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  for (const key of ["ZCODE_INSTALL_DIR", "ZCODE_WINDOWS_APP_INSTALL_DIR"]) {
    const val = env[key]?.trim();
    if (val) roots.push(path.resolve(val));
  }
  if (process.platform === "win32") {
    const localAppData = env["LOCALAPPDATA"]?.trim();
    if (localAppData) roots.push(path.join(localAppData, "Programs", "ZCode"));
    const pf = env["ProgramFiles"]?.trim() || env["PROGRAMFILES"]?.trim();
    if (pf) roots.push(path.join(pf, "ZCode"));
    for (const drive of ["C:", "D:", "E:"]) {
      roots.push(path.join(drive, "Program Files", "ZCode"));
    }
  } else if (process.platform === "darwin") {
    roots.push("/Applications/ZCode.app/Contents");
  } else {
    roots.push("/opt/ZCode/app", "/opt/ZCode");
  }
  return [...new Set(roots)];
}

export function discoverZCodeRuntime(env: NodeJS.ProcessEnv = process.env): ZCodeRuntimePaths {
  const dataPaths = resolveZCodeDataPaths(env);
  const explicitCjs = env["ZCODE_CJS_PATH"]?.trim();
  const explicitBuiltin = env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]?.trim();
  const nodeExecutable = env["ZCODE_NODE_PATH"]?.trim() || process.execPath;

  let installDir = "";
  let zcodeEntrypoint = explicitCjs ? path.resolve(explicitCjs) : "";
  let builtinConfigFile = explicitBuiltin ? path.resolve(explicitBuiltin) : "";

  if (zcodeEntrypoint) {
    installDir = path.resolve(path.dirname(zcodeEntrypoint), "..", "..");
    if (!builtinConfigFile) {
      builtinConfigFile = path.join(path.dirname(zcodeEntrypoint), "..", "config", "provider", "zcode-builtin.json");
    }
  } else {
    for (const root of candidateInstallRoots(env)) {
      const cjs = path.join(root, "resources", "glm", "zcode.cjs");
      const builtin = path.join(root, "resources", "config", "provider", "zcode-builtin.json");
      if (existsSync(cjs) && (builtinConfigFile ? existsSync(builtinConfigFile) : existsSync(builtin))) {
        installDir = root;
        zcodeEntrypoint = cjs;
        if (!builtinConfigFile) builtinConfigFile = builtin;
        break;
      }
    }
  }

  if (!zcodeEntrypoint || !existsSync(zcodeEntrypoint)) {
    throw new Error(
      `ZCode runtime (zcode.cjs) not found. Set ZCODE_INSTALL_DIR or ZCODE_CJS_PATH. Searched: ${candidateInstallRoots(env).join(", ")}`,
    );
  }
  if (!builtinConfigFile || !existsSync(builtinConfigFile)) {
    throw new Error(`ZCode builtin provider config not found at ${builtinConfigFile || "(unset)"}`);
  }
  if (!existsSync(dataPaths.personalConfigFile)) {
    throw new Error(`ZCode personal provider_config.json not found at ${dataPaths.personalConfigFile}. Please sign in or configure ZCode first.`);
  }

  const rgCandidate = path.join(
    installDir,
    "resources",
    "tools",
    "ripgrep",
    process.platform === "win32" ? "rg.exe" : "rg",
  );
  const ugrepCandidate = path.join(
    installDir,
    "resources",
    "tools",
    "ugrep",
    process.platform === "win32" ? "ugrep.exe" : "ugrep",
  );
  const meta = readDesktopAsarMetadata(zcodeEntrypoint);

  return {
    nodeExecutable,
    installDir,
    zcodeEntrypoint,
    builtinConfigFile,
    personalConfigFile: dataPaths.personalConfigFile,
    zcodeDataDir: dataPaths.zcodeDataDir,
    cliDbPath: dataPaths.cliDbPath,
    tasksIndexPath: dataPaths.tasksIndexPath,
    rgBinary: existsSync(rgCandidate) ? rgCandidate : null,
    ugrepBinary: existsSync(ugrepCandidate) ? ugrepCandidate : null,
    appVersion: meta?.appVersion ?? null,
    buildCommitId: meta?.buildCommitId ?? null,
  };
}

export function buildZCodeChildEnv(
  runtime: ZCodeRuntimePaths,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = process.platform === "win32" ? WINDOWS_OS_ENV_KEYS : POSIX_OS_ENV_KEYS;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  if (process.platform === "win32") {
    env["HOME"] = resolveUserHome(sourceEnv);
  }
  env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"] = runtime.builtinConfigFile;
  env["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"] = runtime.personalConfigFile;
  if (runtime.rgBinary) env["ZCODE_RG_BINARY"] = runtime.rgBinary;
  if (runtime.ugrepBinary) env["ZCODE_UGREP_BINARY"] = runtime.ugrepBinary;
  if (runtime.appVersion) env["ZCODE_APP_VERSION"] = runtime.appVersion;
  if (runtime.buildCommitId) env["ZCODE_BUILD_COMMIT_ID"] = runtime.buildCommitId;
  return env;
}

interface AsarEntry {
  offset?: string | number;
  size?: string | number;
  files?: Record<string, AsarEntry>;
}

function readDesktopAsarMetadata(zcodeEntrypoint: string): { appVersion: string; buildCommitId: string } | null {
  const asarPath = path.resolve(path.dirname(zcodeEntrypoint), "..", "app.asar");
  if (!existsSync(asarPath)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(asarPath, "r");
    const headerSizeBuf = Buffer.alloc(16);
    if (readSync(fd, headerSizeBuf, 0, 16, 0) !== 16) return null;
    if (headerSizeBuf.readUInt32LE(0) !== 4) return null;
    const payloadSize = headerSizeBuf.readUInt32LE(4);
    const jsonSize = headerSizeBuf.readUInt32LE(12);
    if (jsonSize === 0 || jsonSize > 32 * 1024 * 1024 || payloadSize < jsonSize) return null;

    const headerBuf = Buffer.alloc(jsonSize);
    if (readSync(fd, headerBuf, 0, jsonSize, 16) !== jsonSize) return null;
    const header = JSON.parse(headerBuf.toString("utf8")) as { files?: Record<string, AsarEntry> };
    const metaEntry = header.files?.["out"]?.files?.["metadata"]?.files?.["build-meta.json"];
    if (!metaEntry || metaEntry.offset === undefined || metaEntry.size === undefined) return null;

    const size = Number(metaEntry.size);
    const offset = Number(metaEntry.offset);
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || size <= 0 || size > 64 * 1024) return null;

    const metaBuf = Buffer.alloc(size);
    if (readSync(fd, metaBuf, 0, size, 8 + payloadSize + offset) !== size) return null;
    const meta = JSON.parse(metaBuf.toString("utf8")) as { appVersion?: unknown; buildCommitId?: unknown };
    if (typeof meta.appVersion !== "string" || typeof meta.buildCommitId !== "string") return null;
    return { appVersion: meta.appVersion, buildCommitId: meta.buildCommitId };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
