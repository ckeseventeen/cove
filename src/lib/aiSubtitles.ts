export type AiProvider = "siliconflow" | "groq" | "openai" | "custom";

const PROVIDERS: readonly string[] = ["siliconflow", "groq", "openai", "custom"];

function isProvider(value: string | null): value is AiProvider {
  return value !== null && PROVIDERS.includes(value);
}

/** Only the custom service takes an endpoint; built-in services always use their own address. */
export function aiEndpoint(provider: AiProvider, baseUrl: string): string | undefined {
  return provider === "custom" ? baseUrl.trim() || undefined : undefined;
}

/**
 * The service the saved key belongs to, so it is only ever offered to that service.
 * A key saved before the owner was recorded belongs to the last built-in service used
 * (the default one if none was recorded); a custom endpoint never inherits it.
 */
export function savedKeyOwner(recorded: string | null, lastProvider: string | null): AiProvider | null {
  if (isProvider(recorded)) return recorded;
  const fallback = lastProvider ?? "siliconflow";
  return isProvider(fallback) && fallback !== "custom" ? fallback : null;
}
