import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createLlmConnection } from "../src/llm/LlmClient";
import { ResponderService } from "../src/responder/ResponderService";
import { SimplifierService } from "../src/simplifier/SimplifierService";

interface ChatRequest {
	model: string;
	messages: { role: string; content: string }[];
	response_format?: { type: string };
}

/** Offline check using the real OpenAI SDK against a local HTTP fixture. */
async function main() {
	const keys = [
		"OPENAI_BASE_URL",
		"OPENAI_MODEL",
		"OPENAI_API_KEY",
		"XAI_API_KEY",
		"NODE_ENV",
	] as const;
	const previous = keys.map((key) => process.env[key]);
	const originalError = console.error;
	const originalWarn = console.warn;
	const errors: unknown[][] = [];
	const warnings: unknown[][] = [];
	const requests: { url?: string; method?: string; authorization?: string; body: ChatRequest }[] =
		[];
	let content: string | null = "ローカルLLMからの返答";
	let status = 200;
	const server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
			requests.push({
				url: request.url,
				method: request.method,
				authorization: request.headers.authorization,
				body: JSON.parse(Buffer.concat(chunks).toString()) as ChatRequest,
			});
			response.writeHead(status, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify(
					status === 200
						? { choices: [{ message: { role: "assistant", content } }] }
						: { error: { message: "Local model unavailable" } }
				)
			);
		})().catch((error: unknown) => {
			console.error(error);
			response.writeHead(500).end();
		});
	});

	try {
		for (const key of keys) delete process.env[key];
		process.env.NODE_ENV = "test";
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		console.warn = (...args: unknown[]) => {
			warnings.push(args);
		};
		assert.equal(createLlmConnection("check"), null);
		assert.equal(await new ResponderService().respond("こんにちは"), null);
		assert.equal(await new SimplifierService().simplify("文章", true), null);

		process.env.XAI_API_KEY = "xai-fixture-key";
		const legacy = createLlmConnection("check");
		assert.equal(legacy?.client.baseURL, "https://api.x.ai/v1");
		assert.equal(legacy?.model, "grok-4-1-fast-non-reasoning");
		console.log("PASS disabled configuration and legacy xAI settings (no external requests)");

		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		assert(address && typeof address !== "string");
		process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
		// Incomplete custom settings must never fall back to xAI.
		assert.equal(createLlmConnection("check"), null);
		assert(warnings.some((args) => String(args[0]).includes("OPENAI_MODEL")));
		process.env.OPENAI_MODEL = "local-test-model";

		const responder = new ResponderService();
		assert.equal(await responder.respond("こんにちは"), content);
		assert.equal(requests[0].url, "/v1/chat/completions");
		assert.equal(requests[0].method, "POST");
		assert.equal(requests[0].authorization, "Bearer local-llm");
		assert.equal(requests[0].body.model, "local-test-model");
		assert.deepEqual(requests[0].body.messages, [
			{ role: "system", content: responder.systemPrompt },
			{ role: "user", content: "こんにちは" },
		]);
		assert.equal(requests[0].body.response_format, undefined);
		assert.equal(await responder.respond("   "), null);
		assert.equal(requests.length, 1);
		console.log(
			"PASS custom endpoint takes priority over xAI; model, messages and keyless connection"
		);

		process.env.OPENAI_API_KEY = "local-fixture-key";
		process.env.OPENAI_BASE_URL += "/";
		content = "認証付きの返答";
		assert.equal(await new ResponderService().respond("認証テスト"), content);
		assert.equal(requests[1].authorization, "Bearer local-fixture-key");
		assert.equal(requests[1].url, "/v1/chat/completions");
		console.log("PASS explicit API key and trailing slash in base URL");

		const simplifier = new SimplifierService();
		content = JSON.stringify({ isRedundant: true, simplifiedText: "予定を見直してください" });
		assert.equal(
			await simplifier.simplify("プロジェクトの予定について詳しく説明します", true),
			"「予定を見直してください」で伝わります。"
		);
		const summaryRequest = requests[2];
		assert.equal(summaryRequest.url, "/v1/chat/completions");
		assert.equal(summaryRequest.body.model, "local-test-model");
		assert.equal(summaryRequest.authorization, "Bearer local-fixture-key");
		assert.deepEqual(summaryRequest.body.response_format, { type: "json_object" });
		assert(summaryRequest.body.messages[0].content.includes("JSON"));
		content = JSON.stringify({ isRedundant: false, simplifiedText: null });
		assert.equal(await simplifier.simplify("これは普通の文章です", true), null);
		const count = requests.length;
		assert.equal(await simplifier.simplify("短文"), null);
		assert.equal(requests.length, count);
		console.log("PASS simplifier JSON request, summary parsing and short-message skip");

		content = null;
		assert.equal(await responder.respond("空の応答"), null);
		content = "invalid JSON";
		assert.equal(await simplifier.simplify("JSONではない応答です", true), null);
		status = 503;
		const beforeFailure = requests.length;
		assert.equal(await responder.respond("HTTPエラー"), null);
		assert.equal(await simplifier.simplify("HTTPエラーを確認します", true), null);
		assert.equal(requests.length, beforeFailure + 2);
		assert.equal(errors.length, 3);
		console.log("PASS empty response, invalid JSON and HTTP failure handling without retries");
	} finally {
		console.error = originalError;
		console.warn = originalWarn;
		for (const [index, key] of keys.entries()) {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		}
		if (server.listening) {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			});
		}
	}
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
