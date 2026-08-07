import type { Pricing, PricingResolution } from "./types.js";

const OPENROUTER_API = "https://openrouter.ai/api/v1";
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface OpenRouterModelResponse {
  data?: {
    id?: unknown;
    canonical_slug?: unknown;
    pricing?: {
      prompt?: unknown;
      completion?: unknown;
      input_cache_read?: unknown;
      internal_reasoning?: unknown;
      overrides?: unknown;
    };
  };
}

function perMillion(value: unknown, field: string): number {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`OpenRouter returned invalid ${field} pricing.`);
  }
  return Number((parsed * 1_000_000).toFixed(12));
}

export function openRouterModelId(model: string): string {
  if (model.includes("/")) return model;
  if (/^(?:gpt-|o\d)/i.test(model)) return `openai/${model}`;
  if (/^claude-/i.test(model)) return `anthropic/${model}`;
  if (/^gemini-/i.test(model)) return `google/${model}`;
  throw new Error(`Cannot infer an OpenRouter model ID for "${model}". Pass --pricing-model <author/slug> or --pricing off.`);
}

export async function fetchOpenRouterPricing(
  benchmarkModel: string,
  providerModel = openRouterModelId(benchmarkModel),
  options: { fetch?: Fetcher; apiBase?: string; now?: () => Date } = {},
): Promise<PricingResolution> {
  const fetcher = options.fetch ?? fetch;
  const apiBase = (options.apiBase ?? OPENROUTER_API).replace(/\/$/, "");
  const modelPath = providerModel.split("/").map(encodeURIComponent).join("/");
  const endpoint = `${apiBase}/model/${modelPath}`;
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(`Could not fetch live pricing for ${providerModel} from OpenRouter: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`OpenRouter pricing lookup for ${providerModel} failed with HTTP ${response.status}. Pass --pricing-model <author/slug> or --pricing off.`);
  }

  let payload: OpenRouterModelResponse;
  try {
    payload = await response.json() as OpenRouterModelResponse;
  } catch (error) {
    throw new Error(`OpenRouter returned invalid JSON for ${providerModel}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const data = payload.data;
  const prices = data?.pricing;
  if (!data || typeof data.id !== "string" || !prices) {
    throw new Error(`OpenRouter returned an incomplete model record for ${providerModel}.`);
  }

  const inputPerMillion = perMillion(prices.prompt, "prompt");
  const outputPerMillion = perMillion(prices.completion, "completion");
  const pricing: Pricing = {
    inputPerMillion,
    cachedInputPerMillion: prices.input_cache_read === undefined
      ? inputPerMillion
      : perMillion(prices.input_cache_read, "input_cache_read"),
    outputPerMillion,
    ...(prices.internal_reasoning === undefined
      ? {}
      : { reasoningPerMillion: perMillion(prices.internal_reasoning, "internal_reasoning") }),
  };
  const warnings: string[] = [];
  if (prices.input_cache_read === undefined) {
    warnings.push("OpenRouter did not publish a cached-input price; estimates conservatively use the regular input price for cached tokens.");
  }
  if (Array.isArray(prices.overrides) && prices.overrides.length > 0) {
    warnings.push("OpenRouter publishes context-length price overrides for this model. Codex reports aggregate turn usage without per-request prompt lengths, so estimates use the model's base token prices.");
  }
  return {
    source: "openrouter",
    benchmarkModel,
    sourceUrl: endpoint,
    providerModel: data.id,
    canonicalModel: typeof data.canonical_slug === "string" ? data.canonical_slug : data.id,
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    pricing,
    warnings,
  };
}

export function disabledPricing(benchmarkModel: string): PricingResolution {
  return {
    source: "disabled",
    benchmarkModel,
    pricing: null,
    warnings: ["Pricing was explicitly disabled; cost estimates are unavailable."],
  };
}
