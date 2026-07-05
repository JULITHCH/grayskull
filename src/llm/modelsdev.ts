import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_DIR } from "../config/paths";
import type { ModelPreset } from "../config/settings";
import { DEFAULT_MAX_TOKENS } from "../config/settings";

/**
 * models.dev — an open, community-maintained database of model metadata
 * (context/output limits, reasoning + tool-call support, modalities). Used by
 * `/model import <query>` to seed a /model preset without hand-typing limits.
 * The full dump (~3 MB) is cached in the config dir for a day; everything
 * works offline once cached.
 */

const CACHE_PATH = join(GLOBAL_DIR, "models-dev.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const API_URL = "https://models.dev/api.json";

interface ModelsDevModel {
  id: string;
  name: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  open_weights?: boolean;
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
}

interface ModelsDevProvider {
  id: string;
  name: string;
  models: Record<string, ModelsDevModel>;
}

export interface ModelsDevEntry {
  /** "provider/model-id" — the import handle */
  ref: string;
  provider: string;
  id: string;
  name: string;
  family: string;
  reasoning: boolean;
  toolCall: boolean;
  openWeights: boolean;
  context: number;
  output: number;
  vision: boolean;
}

async function loadDb(): Promise<Record<string, ModelsDevProvider>> {
  const fresh =
    existsSync(CACHE_PATH) && Date.now() - statSync(CACHE_PATH).mtimeMs < CACHE_TTL_MS;
  if (!fresh) {
    try {
      const res = await fetch(API_URL, { signal: AbortSignal.timeout(15000) });
      if (res.ok) writeFileSync(CACHE_PATH, await res.text());
    } catch {
      // offline — fall through to a stale cache if one exists
    }
  }
  if (!existsSync(CACHE_PATH)) {
    throw new Error(`models.dev unreachable and no cache at ${CACHE_PATH}`);
  }
  return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Record<string, ModelsDevProvider>;
}

function toEntry(provider: ModelsDevProvider, m: ModelsDevModel): ModelsDevEntry {
  return {
    ref: `${provider.id}/${m.id}`,
    provider: provider.id,
    id: m.id,
    name: m.name,
    family: m.family ?? "",
    reasoning: m.reasoning ?? false,
    toolCall: m.tool_call ?? false,
    openWeights: m.open_weights ?? false,
    context: m.limit?.context ?? 0,
    output: m.limit?.output ?? 0,
    vision: m.modalities?.input?.includes("image") ?? false,
  };
}

/** Exact "provider/id" lookup, else substring search over ids and names. */
export async function searchModelsDev(query: string, max = 12): Promise<ModelsDevEntry[]> {
  const db = await loadDb();
  const q = query.trim().toLowerCase();
  const slash = q.match(/^([^/]+)\/(.+)$/);
  if (slash) {
    const provider = db[slash[1]!];
    const model = provider?.models[slash[2]!];
    if (provider && model) return [toEntry(provider, model)];
  }
  const words = q.split(/\s+/).filter(Boolean);
  const hits: ModelsDevEntry[] = [];
  for (const provider of Object.values(db)) {
    for (const m of Object.values(provider.models)) {
      const hay = `${provider.id} ${m.id} ${m.name} ${m.family ?? ""}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) hits.push(toEntry(provider, m));
    }
  }
  // prefer tool-calling models (this is an agent) and larger contexts
  hits.sort((a, b) => Number(b.toolCall) - Number(a.toolCall) || b.context - a.context);
  return hits.slice(0, max);
}

/** Seed a /model preset from a models.dev entry. The endpoint stays the active
 *  one (models.dev knows models, not your server); family falls back to the
 *  current one unless the id obviously matches a known family. */
export function presetFromEntry(
  entry: ModelsDevEntry,
  active: { baseURL: string; apiKeyEnv?: string; modelFamily: string },
): ModelPreset {
  const idText = `${entry.family} ${entry.id} ${entry.name}`.toLowerCase();
  const family = /\bglm/.test(idText) ? "glm4.5" : /\bqwen/.test(idText) ? "qwen3.5" : active.modelFamily;
  const preset: ModelPreset = {
    family,
    baseURL: active.baseURL,
    model: entry.id,
  };
  if (active.apiKeyEnv) preset.apiKeyEnv = active.apiKeyEnv;
  if (entry.context) preset.contextWindow = entry.context;
  if (entry.output) preset.maxTokens = Math.min(entry.output, DEFAULT_MAX_TOKENS);
  return preset;
}
