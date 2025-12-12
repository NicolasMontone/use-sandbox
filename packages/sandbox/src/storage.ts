/**
 * Storage interface for persisting sandbox state across processes.
 * 
 * In development, we use the filesystem (like workflow's .next/workflow-data).
 * In production, this could be Redis or another key-value store.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface SandboxStateStorage {
  getInstalledHash(sandboxKey: string): string | null;
  setInstalledHash(sandboxKey: string, hash: string): void;
}

/**
 * File-based storage for development mode.
 * Stores state in .next/.sandbox-state/ directory.
 */
class FileSystemStorage implements SandboxStateStorage {
  private stateDir: string;

  constructor() {
    this.stateDir = join(process.cwd(), ".next", ".sandbox-state");
  }

  private ensureDir(): void {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
  }

  private getFilePath(sandboxKey: string): string {
    // Sanitize key for filesystem
    const safeKey = sandboxKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.stateDir, `${safeKey}.json`);
  }

  getInstalledHash(sandboxKey: string): string | null {
    const filePath = this.getFilePath(sandboxKey);
    try {
      if (!existsSync(filePath)) {
        return null;
      }
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      return data.bundleHash ?? null;
    } catch {
      return null;
    }
  }

  setInstalledHash(sandboxKey: string, hash: string): void {
    this.ensureDir();
    const filePath = this.getFilePath(sandboxKey);
    writeFileSync(
      filePath,
      JSON.stringify({ bundleHash: hash, updatedAt: new Date().toISOString() })
    );
  }
}

/**
 * In-memory storage (fallback, doesn't persist across processes).
 */
class MemoryStorage implements SandboxStateStorage {
  private state = new Map<string, string>();

  getInstalledHash(sandboxKey: string): string | null {
    return this.state.get(sandboxKey) ?? null;
  }

  setInstalledHash(sandboxKey: string, hash: string): void {
    this.state.set(sandboxKey, hash);
  }
}

// Storage singleton - use filesystem in dev, memory as fallback
let storageInstance: SandboxStateStorage | null = null;

export function getStorage(): SandboxStateStorage {
  if (!storageInstance) {
    const isDev = process.env.NODE_ENV !== "production";
    if (isDev) {
      storageInstance = new FileSystemStorage();
    } else {
      // In production, throw for now - user needs to configure storage
      // TODO: Allow configuring Redis or other providers
      console.warn(
        "[use-sandbox] Production storage not configured. " +
          "Bundle updates may not persist across processes. " +
          "Consider configuring a storage provider."
      );
      storageInstance = new MemoryStorage();
    }
  }
  return storageInstance;
}

