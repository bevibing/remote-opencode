import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:net", () => ({
  Server: class MockServer extends EventEmitter {
    listen(port: number, callback?: () => void) {
      setImmediate(() => this.emit("listening"));
      return this;
    }
    close(callback?: () => void) {
      if (callback) {
        setImmediate(() => callback());
      }
      return this;
    }
  },
}));

vi.mock("../services/configStore.js", () => ({
  getPortConfig: vi.fn(),
}));

import * as serveManager from "../services/serveManager.js";
import { getPortConfig } from "../services/configStore.js";
import { spawn } from "node:child_process";

const createMockProcess = (): ChildProcess => {
  const proc = new EventEmitter() as ChildProcess;
  Object.defineProperty(proc, "pid", {
    value: Math.floor(Math.random() * 10000),
    writable: true,
  });
  proc.kill = vi.fn().mockReturnValue(true);
  proc.stdout = new EventEmitter() as any;
  proc.stderr = new EventEmitter() as any;
  return proc;
};

describe("serveManager", () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    originalPath = process.env.PATH;
    vi.stubEnv("PATH", "/nonexistent");
  });

  afterEach(() => {
    serveManager.stopAll();
    vi.unstubAllEnvs();
    process.env.PATH = originalPath;
  });

  describe("spawnServe", () => {
    it("should spawn opencode serve and return port", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const projectPath = "/test/project";
      const port = await serveManager.spawnServe(projectPath);

      expect(port).toBeGreaterThanOrEqual(14097);
      expect(port).toBeLessThanOrEqual(14200);
      expect(spawn).toHaveBeenCalledWith(
        "opencode",
        ["serve", "--port", port.toString()],
        expect.objectContaining({
          cwd: projectPath,
          stdio: ["inherit", "pipe", "pipe"],
        }),
      );

      const spawnOptions = vi.mocked(spawn).mock.calls[0]?.[2];
      expect(spawnOptions).not.toHaveProperty("shell");
    });

    it("should resolve opencode from PATH before spawning", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "remote-opencode-"));
      const executableName =
        process.platform === "win32" ? "opencode.cmd" : "opencode";
      const resolvedPath = join(tempDir, executableName);

      writeFileSync(resolvedPath, "@echo off");
      vi.stubEnv("PATH", tempDir);

      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      try {
        await serveManager.spawnServe("/test/project");
        expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe(resolvedPath);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should return existing port if serve already running for project", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const projectPath = "/test/project";
      const port1 = await serveManager.spawnServe(projectPath);
      const port2 = await serveManager.spawnServe(projectPath);

      expect(port1).toBe(port2);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("should allocate different ports for different projects", async () => {
      vi.mocked(spawn).mockImplementation(() => createMockProcess());

      const port1 = await serveManager.spawnServe("/project1");
      const port2 = await serveManager.spawnServe("/project2");

      expect(port1).not.toBe(port2);
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it("should respect custom port range from config", async () => {
      vi.mocked(spawn).mockImplementation(() => createMockProcess());
      vi.mocked(getPortConfig).mockReturnValue({ min: 20000, max: 20010 });

      const port = await serveManager.spawnServe("/test/custom-port");

      expect(port).toBe(20000);
      expect(spawn).toHaveBeenCalledWith(
        "opencode",
        ["serve", "--port", "20000"],
        expect.anything(),
      );
    });

    it("should clean up when process exits", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const projectPath = "/test/project";
      await serveManager.spawnServe(projectPath);

      expect(serveManager.getPort(projectPath)).toBeDefined();

      mockProc.emit("exit", 0, null);

      // Wait for async exit handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Instance should still exist but be marked as exited
      const state = serveManager.getInstanceState(projectPath);
      expect(state?.exited).toBe(true);
      expect(state?.exitCode).toBe(0);
    });

    it("should track error message when process exits with non-zero code", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const projectPath = "/test/project";
      await serveManager.spawnServe(projectPath);

      // Simulate stderr output before exit
      mockProc.stderr?.emit(
        "data",
        Buffer.from("Error: opencode command not found"),
      );
      mockProc.emit("exit", 1, null);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const state = serveManager.getInstanceState(projectPath);
      expect(state?.exited).toBe(true);
      expect(state?.exitCode).toBe(1);
      expect(state?.exitError).toContain("opencode command not found");
    });

    it("should track error message when process fails to spawn", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const projectPath = process.cwd();
      await serveManager.spawnServe(projectPath);

      const error = new Error("spawn opencode ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockProc.emit("error", error);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const state = serveManager.getInstanceState(projectPath);
      expect(state?.exited).toBe(true);
      expect(state?.exitError).toContain("OpenCode executable not found");
    });

    it("should report missing project path when spawn fails with inaccessible cwd", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const projectPath = "/definitely/missing/project-path";
      await serveManager.spawnServe(projectPath);

      const error = new Error("spawn opencode ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockProc.emit("error", error);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const state = serveManager.getInstanceState(projectPath);
      expect(state?.exited).toBe(true);
      expect(state?.exitError).toContain(
        `Project path does not exist or is not accessible: ${projectPath}`,
      );
    });

    it("should allow respawning after process exits", async () => {
      vi.mocked(spawn).mockImplementation(() => createMockProcess());

      const projectPath = "/test/project";
      const port1 = await serveManager.spawnServe(projectPath);

      // Get the mock process and mark it as exited
      const mockProc1 = vi.mocked(spawn).mock.results[0].value;
      mockProc1.emit("exit", 1, null);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should spawn a new process
      const port2 = await serveManager.spawnServe(projectPath);

      expect(spawn).toHaveBeenCalledTimes(2);
      // Port might be the same or different depending on cleanup timing
      expect(port2).toBeGreaterThanOrEqual(14097);
    });
  });

  describe("getPort", () => {
    it("should return port for running serve", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const projectPath = "/test/project";
      const expectedPort = await serveManager.spawnServe(projectPath);

      const port = serveManager.getPort(projectPath);
      expect(port).toBe(expectedPort);
    });

    it("should return undefined for non-existent serve", () => {
      const port = serveManager.getPort("/non/existent");
      expect(port).toBeUndefined();
    });
  });

  describe("stopServe", () => {
    it("should stop serve and return true", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const projectPath = "/test/project";
      await serveManager.spawnServe(projectPath);

      const result = serveManager.stopServe(projectPath);

      expect(result).toBe(true);
      expect(mockProc.kill).toHaveBeenCalled();
      expect(serveManager.getPort(projectPath)).toBeUndefined();
    });

    it("should return false for non-existent serve", () => {
      const result = serveManager.stopServe("/non/existent");
      expect(result).toBe(false);
    });
  });

  describe("stopAll", () => {
    it("should stop all serve instances", async () => {
      const mockProc1 = createMockProcess();
      const mockProc2 = createMockProcess();
      vi.mocked(spawn)
        .mockReturnValueOnce(mockProc1)
        .mockReturnValueOnce(mockProc2);

      await serveManager.spawnServe("/project1");
      await serveManager.spawnServe("/project2");

      serveManager.stopAll();

      expect(mockProc1.kill).toHaveBeenCalled();
      expect(mockProc2.kill).toHaveBeenCalled();
      expect(serveManager.getPort("/project1")).toBeUndefined();
      expect(serveManager.getPort("/project2")).toBeUndefined();
    });

    it("should handle empty instances gracefully", () => {
      expect(() => serveManager.stopAll()).not.toThrow();
    });
  });

  describe("waitForReady", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it("should resolve when fetch returns ok", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      const promise = serveManager.waitForReady(14097);

      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:14097/session", {
        headers: {},
      });
    });

    it("should retry if fetch fails or returns not ok", async () => {
      vi.mocked(fetch)
        .mockRejectedValueOnce(new Error("Connection refused"))
        .mockResolvedValueOnce({ ok: false } as Response)
        .mockResolvedValueOnce({ ok: true } as Response);

      const promise = serveManager.waitForReady(14097);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      await expect(promise).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("should throw error on timeout", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("Connection refused"));

      const promise = serveManager.waitForReady(14097, 1000);

      const wrappedPromise = expect(promise).rejects.toThrow(
        "Service at port 14097 failed to become ready within 1000ms. Check if 'opencode serve' is working correctly.",
      );

      await vi.advanceTimersByTimeAsync(1500);

      await wrappedPromise;
    });

    it("should fail fast when process exits early with error", async () => {
      vi.useRealTimers();
      vi.mocked(fetch).mockRejectedValue(new Error("Connection refused"));

      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const projectPath = "/test/fast-fail";
      const port = await serveManager.spawnServe(projectPath);

      // Simulate stderr output and immediate exit
      mockProc.stderr?.emit(
        "data",
        Buffer.from("Error: Failed to bind to port"),
      );
      mockProc.emit("exit", 1, null);

      // Wait for exit handler to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Now waitForReady should fail fast with the error message
      await expect(
        serveManager.waitForReady(port, 30000, projectPath),
      ).rejects.toThrow(
        "opencode serve failed to start: Error: Failed to bind to port",
      );

      vi.useFakeTimers();
    });

    it("should still timeout if no projectPath provided and process exits", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("Connection refused"));

      // Without projectPath, can't detect early exit
      const promise = serveManager.waitForReady(14097, 1000);

      const wrappedPromise = expect(promise).rejects.toThrow(
        "Service at port 14097 failed to become ready within 1000ms",
      );

      await vi.advanceTimersByTimeAsync(1500);

      await wrappedPromise;
    });

    describe("OPENCODE_SERVER_PASSWORD auth", () => {
      const originalPassword = process.env.OPENCODE_SERVER_PASSWORD;

      afterEach(() => {
        if (originalPassword === undefined)
          delete process.env.OPENCODE_SERVER_PASSWORD;
        else process.env.OPENCODE_SERVER_PASSWORD = originalPassword;
      });

      it("sends Basic Authorization header to readiness probe when password is set", async () => {
        process.env.OPENCODE_SERVER_PASSWORD = "s3cret";
        vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

        const promise = serveManager.waitForReady(14097);
        await vi.runAllTimersAsync();
        await expect(promise).resolves.toBeUndefined();

        const expected = `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`;
        expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:14097/session", {
          headers: { Authorization: expected },
        });
      });

      it("fails fast with a clear error when readiness probe returns 401", async () => {
        vi.useRealTimers();
        process.env.OPENCODE_SERVER_PASSWORD = "wrong";
        vi.mocked(fetch).mockResolvedValue({
          ok: false,
          status: 401,
        } as Response);

        await expect(serveManager.waitForReady(14097, 5000)).rejects.toThrow(
          /rejected by the opencode server/i,
        );

        vi.useFakeTimers();
      });

      it("fails fast with a clear error when readiness probe returns 401 and password is unset", async () => {
        vi.useRealTimers();
        vi.mocked(fetch).mockResolvedValue({
          ok: false,
          status: 401,
        } as Response);

        await expect(serveManager.waitForReady(14097, 5000)).rejects.toThrow(
          /OPENCODE_SERVER_PASSWORD is not set/i,
        );

        vi.useFakeTimers();
      });
    });
  });
});
