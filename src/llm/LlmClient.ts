import OpenAI from "openai";

export interface LlmConnection {
	client: OpenAI;
	model: string;
}

/** Read settings lazily, after dotenv.config() has run. */
export function createLlmConnection(serviceName: string): LlmConnection | null {
	const baseURL = process.env.OPENAI_BASE_URL?.trim();
	const model = process.env.OPENAI_MODEL?.trim();
	const apiKey = process.env.OPENAI_API_KEY?.trim();

	if (baseURL || model || apiKey) {
		if (!baseURL || !model) {
			console.warn(
				`${serviceName}: OPENAI_BASE_URL and OPENAI_MODEL are both required. LLM is disabled.`
			);
			return null;
		}
		return {
			client: new OpenAI({
				baseURL,
				apiKey: apiKey || "local-llm",
				timeout: 120_000,
				maxRetries: 0,
			}),
			model,
		};
	}

	// Preserve the existing xAI configuration when no custom endpoint is set.
	if (process.env.XAI_API_KEY) {
		return {
			client: new OpenAI({
				baseURL: "https://api.x.ai/v1",
				apiKey: process.env.XAI_API_KEY,
			}),
			model: "grok-4-1-fast-non-reasoning",
		};
	}

	if (process.env.NODE_ENV !== "test") {
		console.warn(
			`${serviceName}: Set OPENAI_BASE_URL and OPENAI_MODEL (or XAI_API_KEY) to enable LLM.`
		);
	}
	return null;
}
