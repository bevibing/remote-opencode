import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { Server } from "node:net";
import { delimiter, join } from "node:path";
import type { ServeInstance } from "../types/index.js";
import { getPortConfig } from "./configStore.js";
import { getAuthHeaders, isAuthEnabled } from "./serverAuth.js";

const DEFAULT_PORT_MIN = 14097;
const DEFAULT_PORT_MAX = 14200;
const WINDOWS_OPENCODE_COMMANDS = ["opencode.cmd", "opencode.exe", "opencode"];
const POSIX_OPENCODE_COMMANDS = ["opencode"];

const instances = new Map<string, ServeInstance>();

function getOpencodeCommandCandidates(): string[] {
  return process.platform === "win32"
    ? WINDOWS_OPENCODE_COMMANDS
    : POSIX_OPENCODE_COMMANDS;
}

function resolveCommandFromPath(
  command: string,
  pathValue?: string,
): string | undefined {
  if (!pathValue) {
    return undefined;
  }

  for (const pathEntry of pathValue.split(delimiter)) {
    if (!pathEntry) {
      continue;
    }

    const resolved = join(pathEntry, command);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  return undefined;
}

function resolveOpencodeCommand(env: NodeJS.ProcessEnv): string {
  const pathValue = env.PATH ?? env.Path;

  for (const command of getOpencodeCommandCandidates()) {
    const resolved = resolveCommandFromPath(command, pathValue);
    if (resolved) {
      return resolved;
    }
  }

  return getOpencodeCommandCandidates()[0];
}

function formatSpawnError(
  error: Error,
  command: string,
  projectPath: string,
): string {
  const spawnError = error as NodeJS.ErrnoException;

  if (!existsSync(projectPath)) {
    return `Project path does not exist or is not accessible: ${projectPath}`;
  }

  if (spawnError.code === "ENOENT") {
    return `OpenCode executable not found: ${command}. Ensure OpenCode is installed and available in PATH for this service.`;
  }

  if (spawnError.code === "EACCES") {
    return `OpenCode executable is not accessible: ${command}. Check file permissions and service user access.`;
  }

  return spawnError.message || "Failed to spawn opencode process";
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = new Server();

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });

    // Bind to 127.0.0.1 explicitly to match opencode serve's default binding
    server.listen(port, "127.0.0.1");
  });
}

async function isOrphanedServerRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/session`, {
      headers: getAuthHeaders(),
      signal: AbortSignal.timeout(1000),
    });
    // Any HTTP response (including 401 when auth is required) means a server
    // is already listening on this port. We treat the port as in-use.
    void response;
    return true;
  } catch {
    return false;
  }
}

async function findAvailablePort(): Promise<number> {
  const config = getPortConfig();
  const min = config?.min ?? DEFAULT_PORT_MIN;
  const max = config?.max ?? DEFAULT_PORT_MAX;

  for (let port = min; port <= max; port++) {
    const usedPorts = new Set(
      Array.from(instances.values())
        .filter((i) => !i.exited)
        .map((i) => i.port),
    );
    if (usedPorts.has(port)) {
      continue;
    }

    // Check if there's an orphaned opencode server on this port
    if (await isOrphanedServerRunning(port)) {
      continue;
    }

    // Check if we can bind to this port
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available ports in range ${min}-${max}`);
}

async function isServerResponding(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/session`, {
      headers: getAuthHeaders(),
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function cleanupInstance(key: string): void {
  instances.delete(key);
}

export async function spawnServe(
  projectPath: string,
  model?: string,
): Promise<number> {
  const key = model ? `${projectPath}:${model}` : projectPath;
  const existing = instances.get(key);
  if (existing && !existing.exited) {
    return existing.port;
  }

  // Clean up any exited instance before spawning a new one
  if (existing?.exited) {
    cleanupInstance(key);
  }

  const port = await findAvailablePort();

  // Note: opencode serve doesn't support --model flag
  // Model selection must happen at session/prompt level, not server startup
  const args = ["serve", "--port", port.toString()];
  const env = { ...process.env };
  const command = resolveOpencodeCommand(env);

  console.log(`[opencode] Spawning: ${command} ${args.join(" ")}`);
  console.log(`[opencode] Working directory: ${projectPath}`);

  const child = spawn(command, args, {
    cwd: projectPath,
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });

  const instance: ServeInstance = {
    port,
    process: child,
    startTime: Date.now(),
    exited: false,
  };

  instances.set(key, instance);

  let stderrBuffer = "";
  let stdoutBuffer = "";

  child.stdout?.on("data", (data) => {
    const text = data.toString();
    stdoutBuffer += text;
    if (stdoutBuffer.length > 2000) {
      stdoutBuffer = stdoutBuffer.slice(-2000);
    }
    console.log(`[opencode stdout] ${text.trim()}`);
  });

  child.stderr?.on("data", (data) => {
    const text = data.toString();
    stderrBuffer += text;
    if (stderrBuffer.length > 2000) {
      stderrBuffer = stderrBuffer.slice(-2000);
    }
    console.error(`[opencode stderr] ${text.trim()}`);
  });

  child.on("exit", (code) => {
    const inst = instances.get(key);
    if (inst) {
      inst.exited = true;
      inst.exitCode = code;
      if (code !== 0 && code !== null) {
        // Combine stdout and stderr for error message
        const combinedOutput = stderrBuffer.trim() || stdoutBuffer.trim();
        inst.exitError = combinedOutput || `Process exited with code ${code}`;
        console.error(`[opencode] Process exited with code ${code}`);
        if (combinedOutput) {
          console.error(`[opencode] Output: ${combinedOutput}`);
        }
      }
    }
  });

  child.on("error", (error) => {
    const formattedError = formatSpawnError(error, command, projectPath);
    console.error(`[opencode] Spawn error: ${formattedError}`);
    const inst = instances.get(key);
    if (inst) {
      inst.exited = true;
      inst.exitError = formattedError;
    }
  });

  return port;
}

export function getPort(
  projectPath: string,
  model?: string,
): number | undefined {
  const key = model ? `${projectPath}:${model}` : projectPath;
  return instances.get(key)?.port;
}

export function stopServe(projectPath: string, model?: string): boolean {
  const key = model ? `${projectPath}:${model}` : projectPath;
  const instance = instances.get(key);
  if (!instance) {
    return false;
  }

  instance.process.kill();
  cleanupInstance(key);
  return true;
}

export async function waitForReady(
  port: number,
  timeout: number = 30000,
  projectPath?: string,
  model?: string,
): Promise<void> {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/session`;
  const key = projectPath
    ? model
      ? `${projectPath}:${model}`
      : projectPath
    : null;

  while (Date.now() - start < timeout) {
    // Check if the process has exited early
    if (key) {
      const instance = instances.get(key);
      if (instance?.exited) {
        const errorMsg =
          instance.exitError ||
          `opencode serve exited with code ${instance.exitCode}`;
        cleanupInstance(key);
        throw new Error(`opencode serve failed to start: ${errorMsg}`);
      }
    }

    try {
      const response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        return;
      }
      if (response.status === 401 || response.status === 403) {
        const hint = isAuthEnabled()
          ? "credentials were rejected by the opencode server. Verify OPENCODE_SERVER_PASSWORD (and OPENCODE_SERVER_USERNAME if set) match the values opencode serve was started with."
          : "opencode server requires authentication but OPENCODE_SERVER_PASSWORD is not set in this process.";
        throw new Error(
          `opencode serve is running on port ${port} but ${hint}`,
        );
      }
    } catch (err) {
      // Surface auth errors immediately instead of silently retrying until timeout.
      if (
        err instanceof Error &&
        err.message.startsWith("opencode serve is running on port")
      ) {
        throw err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Final check - did the process exit?
  if (key) {
    const instance = instances.get(key);
    if (instance?.exited) {
      const errorMsg =
        instance.exitError ||
        `opencode serve exited with code ${instance.exitCode}`;
      cleanupInstance(key);
      throw new Error(`opencode serve failed to start: ${errorMsg}`);
    }
  }

  throw new Error(
    `Service at port ${port} failed to become ready within ${timeout}ms. Check if 'opencode serve' is working correctly.`,
  );
}

export function stopAll(): void {
  for (const [key, instance] of instances) {
    instance.process.kill();
    cleanupInstance(key);
  }
}

export function getAllInstances(): Array<{ key: string; port: number }> {
  return Array.from(instances.entries()).map(([key, instance]) => ({
    key,
    port: instance.port,
  }));
}

export function getInstanceState(
  projectPath: string,
  model?: string,
):
  | { exited: boolean; exitCode?: number | null; exitError?: string }
  | undefined {
  const key = model ? `${projectPath}:${model}` : projectPath;
  const instance = instances.get(key);
  if (!instance) return undefined;
  return {
    exited: instance.exited ?? false,
    exitCode: instance.exitCode,
    exitError: instance.exitError,
  };
}
