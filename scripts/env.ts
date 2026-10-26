import { existsSync, readFileSync } from "node:fs";

/** Reads the VITE_* settings from .env.local, or from .env.example when there is no .env.local. */
export function readEnvFile(): Record<string, string> {
  const local = new URL("../.env.local", import.meta.url);
  const file = existsSync(local) ? local : new URL("../.env.example", import.meta.url);
  const settings: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!/^VITE_\w+=/.test(line)) continue;
    const separator = line.indexOf("=");
    settings[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return settings;
}
