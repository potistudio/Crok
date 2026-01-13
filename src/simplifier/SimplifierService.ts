import OpenAI from 'openai';

interface SimplificationResult {
	isRedundant: boolean;
	simplifiedText: string | null;
}

export class SimplifierService {
	private openai: OpenAI | null = null;
	private readonly SYSTEM_PROMPT = `
冗長な文章を指摘し簡潔に直せ
入力されたメッセージが必要に回りくどい、長すぎる、要点が分かりにくい（冗長である）かどうかを判定しろ
- 冗長でない場合（通常会話、短い文章、俳句、詩的表現等）: \`isRedundant\` を \`false\` にしろ
- 冗長である場合: \`isRedundant\` を \`true\` にし、その文章を意味を損なわずに可能な限り簡潔に要約し \`simplifiedText\` に出力しろ
    `.trim();

	constructor() {
		// Initialization is handled lazily or via explicit call if needed for testing
	}

	private getClient(): OpenAI | null {
		if (this.openai) return this.openai;

		const apiKey = process.env.XAI_API_KEY;
		if (apiKey) {
			this.openai = new OpenAI({
				apiKey: apiKey,
				baseURL: 'https://api.x.ai/v1',
			});
			console.log('SimplifierService initialized with Grok API.');
		} else {
			// Warn only once? Or every time? Let's warn once.
			if (process.env.NODE_ENV !== 'test') {
				console.warn('XAI_API_KEY is not set. SimplifierService will be disabled.');
			}
		}
		return this.openai;
	}

	async simplify(text: string, force: boolean = false): Promise<string | null> {
		const client = this.getClient();
		if (!client) return null;

		// 短すぎる文章は無視 (force=trueの場合はチェックしない)
		if (!force && text.length < 80) return null;

		try {
			const completion = await client.chat.completions.create({
				model: 'grok-4-1-fast-non-reasoning',
				messages: [
					{ role: 'system', content: this.SYSTEM_PROMPT },
					{ role: 'user', content: text }
				],
				// JSON mode is supported by Grok? If not, we might need to parse manually.
				// Assuming standard JSON output capability or careful prompting.
				// xAI currently supports structured output in beta or via prompting.
				// Let's use simple JSON prompting for robust compatibility.
				response_format: { type: 'json_object' }
			});

			const content = completion.choices[0]?.message?.content;
			if (!content) return null;

			const result = JSON.parse(content) as SimplificationResult;

			if (result.isRedundant && result.simplifiedText) {
				return `「${result.simplifiedText}」で伝わります。`;
			}

			return null;
		} catch (error) {
			console.error('Error in SimplifierService:', error);
			return null;
		}
	}
}

export const simplifierService = new SimplifierService();
