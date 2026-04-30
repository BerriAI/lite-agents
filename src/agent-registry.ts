import { readFileSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import type { AgentEntrypoint } from "./agent-spec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = resolve(__dirname, "../agents.json");

interface AgentEntry {
  path: string;
  export?: string;
  description?: string;
}

interface RegistryFile {
  default?: string;
  agents: Record<string, AgentEntry>;
}

export interface AgentInfo {
  name: string;
  path: string;
  export: string;
  description?: string;
  isDefault: boolean;
}

const cache = new Map<string, AgentEntrypoint>();
let registry: RegistryFile | null = null;

function loadRegistry(): RegistryFile {
  if (registry) return registry;
  let raw: string;
  try { raw = readFileSync(REGISTRY_PATH, "utf8"); }
  catch (e) { throw new Error(`agent-registry: cannot read ${REGISTRY_PATH}: ${(e as Error).message}`); }
  try { registry = JSON.parse(raw) as RegistryFile; }
  catch (e) { throw new Error(`agent-registry: invalid JSON in ${REGISTRY_PATH}: ${(e as Error).message}`); }
  if (!registry.agents || typeof registry.agents !== "object") {
    throw new Error(`agent-registry: ${REGISTRY_PATH} must have an "agents" object`);
  }
  return registry;
}

export function listAgents(): AgentInfo[] {
  const reg = loadRegistry();
  return Object.entries(reg.agents).map(([name, entry]) => ({
    name,
    path: entry.path,
    export: entry.export ?? "default",
    description: entry.description,
    isDefault: name === reg.default,
  }));
}

export function defaultAgentName(): string {
  const reg = loadRegistry();
  if (reg.default && reg.agents[reg.default]) return reg.default;
  const first = Object.keys(reg.agents)[0];
  if (!first) throw new Error("agent-registry: no agents registered");
  return first;
}

export async function getAgent(name?: string | null): Promise<AgentEntrypoint> {
  const reg = loadRegistry();
  const key = name && reg.agents[name] ? name : defaultAgentName();
  const cached = cache.get(key);
  if (cached) return cached;

  const entry = reg.agents[key];
  const exportName = entry.export ?? "default";
  const filePath = isAbsolute(entry.path) ? entry.path : resolve(dirname(REGISTRY_PATH), entry.path);
  const url = pathToFileURL(filePath).href;

  let mod: Record<string, unknown>;
  try { mod = (await import(url)) as Record<string, unknown>; }
  catch (e) { throw new Error(`agent-registry: failed to import "${key}" from ${filePath}: ${(e as Error).message}`); }

  const fn = mod[exportName];
  if (typeof fn !== "function") {
    throw new Error(`agent-registry: "${key}" — export "${exportName}" not found or not a function in ${filePath}`);
  }
  const agent = fn as AgentEntrypoint;
  cache.set(key, agent);
  return agent;
}
