import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ModelOverrides {
  /** Default model per provider key (e.g. { claude: "claude-opus-4-5-20250929" }). */
  defaultModels?: Record<string, string>;
}

/**
 * JSON-backed store for model configuration set via /settings.
 * Values here override the env-based defaults from config.ts.
 */
export class ModelStore {
  private _path: string;
  private _data: ModelOverrides = {};

  constructor(filePath: string) {
    this._path = filePath;
    this._load();
  }

  all(): ModelOverrides {
    return {
      defaultModels: { ...(this._data.defaultModels ?? {}) },
    };
  }

  getDefaultModel(providerKey: string): string | undefined {
    return this._data.defaultModels?.[providerKey];
  }

  setDefaultModel(providerKey: string, model: string | null): void {
    if (!this._data.defaultModels) this._data.defaultModels = {};
    if (model) {
      this._data.defaultModels[providerKey] = model;
    } else {
      delete this._data.defaultModels[providerKey];
    }
    this._save();
  }

  private _load(): void {
    try {
      const raw = readFileSync(this._path, "utf-8");
      const parsed = JSON.parse(raw) as ModelOverrides;
      this._data = {
        defaultModels:
          parsed.defaultModels && typeof parsed.defaultModels === "object"
            ? { ...parsed.defaultModels }
            : {},
      };
    } catch {
      this._data = {};
    }
  }

  private _save(): void {
    try {
      mkdirSync(dirname(this._path), { recursive: true });
      writeFileSync(this._path, JSON.stringify(this._data, null, 2), "utf-8");
    } catch (e) {
      console.error(`[model-store] failed to save: ${e}`);
    }
  }
}

export function defaultModelStorePath(): string {
  return join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".agent-remote",
    "models.json",
  );
}
