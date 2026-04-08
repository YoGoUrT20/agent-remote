import type { RESTOptions } from "@discordjs/rest";
import { discordUndiciMakeRequest } from "./discord-undici-request.js";

declare const Bun: { readonly version?: string } | undefined;

export function isBunRuntime(): boolean {
  return typeof Bun !== "undefined" || Boolean(process.versions.bun);
}

export function bunRestOptions(): Partial<Pick<RESTOptions, "makeRequest">> {
  if (!isBunRuntime()) {
    return {};
  }
  return {
    makeRequest: discordUndiciMakeRequest as RESTOptions["makeRequest"],
  };
}
