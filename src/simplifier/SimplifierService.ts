import OpenAI from "openai";

interface SimplificationResult {
	isRedundant: boolean;
	simplifiedText: string | null;
}

export class SimplifierService {
	private openai: OpenAI | null = null;

	/** デバッグモード */
	public debug: boolean = false;

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
				baseURL: "https://api.x.ai/v1",
			});
			console.log("SimplifierService initialized with Grok API.");
		} else {
			// Warn only once? Or every time? Let's warn once.
			if (process.env.NODE_ENV !== "test") {
				console.warn("XAI_API_KEY is not set. SimplifierService will be disabled.");
			}
		}
		return this.openai;
	}

	/**
	 * 極端な繰り返しや単純なかさ増しの文章を検出
	 * @param text 入力テキスト
	 * @returns 繰り返し/かさ増しが検出された場合 true
	 */
	private isRepetitiveText(text: string): boolean {
		// 空白・改行を除去して正規化
		const normalized = text.replace(/\s+/g, "");
		if (normalized.length < 10) return false;

		// 1. 同一文字の連続（例: "ああああああ"）
		// 全体の50%以上が同じ文字なら繰り返しとみなす
		const charCounts = new Map<string, number>();
		for (const char of normalized) {
			charCounts.set(char, (charCounts.get(char) || 0) + 1);
		}
		const maxCharCount = Math.max(...charCounts.values());
		if (maxCharCount / normalized.length > 0.5) {
			return true;
		}

		// 2. 短いパターンの繰り返し（例: "hogefugahogefuga..."）
		// 2〜10文字のパターンが完全に繰り返されていれば繰り返しとみなす
		for (
			let patternLen = 2;
			patternLen <= Math.min(10, Math.floor(normalized.length / 3));
			patternLen++
		) {
			const pattern = normalized.slice(0, patternLen);
			const repeated = pattern
				.repeat(Math.ceil(normalized.length / patternLen))
				.slice(0, normalized.length);
			if (repeated === normalized) {
				return true;
			}
		}

		// 3. ユニーク文字率が極端に低い（全体の文字種が少なすぎる）
		// 20文字以上で、ユニーク文字が5種類以下なら怪しい
		if (normalized.length >= 20 && charCounts.size <= 5) {
			return true;
		}

		// 4. N-gram頻度分析（部分一致の繰り返しを検出）
		// 3〜8文字のN-gramを抽出し、同じパターンが高頻度で出現するか確認
		for (const n of [3, 4, 5, 6, 7, 8]) {
			if (normalized.length < n * 3) continue; // 最低3回出現する長さが必要

			const ngramCounts = new Map<string, number>();
			for (let i = 0; i <= normalized.length - n; i++) {
				const ngram = normalized.slice(i, i + n);
				ngramCounts.set(ngram, (ngramCounts.get(ngram) || 0) + 1);
			}

			// 最も頻出するN-gramの出現回数
			const maxNgramCount = Math.max(...ngramCounts.values());
			const totalPossibleNgrams = normalized.length - n + 1;

			// 期待出現回数（ランダムな場合の理論値）と比較して異常に高い場合
			// N-gramがテキストの30%以上をカバーしている場合は繰り返しとみなす
			// （最大出現回数 × N-gram長 / テキスト長 > 0.3）
			if ((maxNgramCount * n) / normalized.length > 0.3 && maxNgramCount >= 3) {
				return true;
			}
		}

		return false;
	}

	async simplify(text: string, force: boolean = false): Promise<string | null> {
		const client = this.getClient();
		if (!client) return null;

		// 短すぎる文章は無視 (force=trueの場合はチェックしない)
		if (!force && text.length < 80) {
			if (this.debug) {
				console.log(`[SimplifierService] Skip: text too short (${text.length} < 80)`);
			}
			return null;
		}

		// 繰り返し/かさ増しテキストは無視
		if (this.isRepetitiveText(text)) {
			if (this.debug) {
				console.log(`[SimplifierService] Skip: repetitive text detected`);
			}
			return null;
		}

		if (this.debug) {
			console.log(
				`[SimplifierService] Analyzing text (${text.length} chars): "${text.substring(0, 50)}..."`
			);
		}

		try {
			const completion = await client.chat.completions.create({
				model: "grok-4-1-fast-non-reasoning",
				messages: [
					{ role: "system", content: this.SYSTEM_PROMPT },
					{ role: "user", content: text },
				],
				// JSON mode is supported by Grok? If not, we might need to parse manually.
				// Assuming standard JSON output capability or careful prompting.
				// xAI currently supports structured output in beta or via prompting.
				// Let's use simple JSON prompting for robust compatibility.
				response_format: { type: "json_object" },
			});

			const content = completion.choices[0]?.message?.content;
			if (!content) {
				if (this.debug) {
					console.log(`[SimplifierService] No content in response`);
				}
				return null;
			}

			if (this.debug) {
				console.log(`[SimplifierService] API Response: ${content}`);
			}

			const result = JSON.parse(content) as SimplificationResult;

			if (result.isRedundant && result.simplifiedText) {
				if (this.debug) {
					console.log(`[SimplifierService] ✅ Redundant: "${result.simplifiedText}"`);
				}
				return `「${result.simplifiedText}」で伝わります。`;
			}

			if (this.debug) {
				console.log(`[SimplifierService] ❌ Not redundant`);
			}
			return null;
		} catch (error) {
			console.error("Error in SimplifierService:", error);
			return null;
		}
	}
}

export const simplifierService = new SimplifierService();
