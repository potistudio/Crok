import OpenAI from "openai";

export class ResponderService {
	private openai: OpenAI | null = null;

	/** デバッグモード */
	public debug: boolean = false;

	/** システムプロンプト（カスタマイズ可能） */
	public systemPrompt: string = `あなたはCrokという名前の淫夢厨。
ただの淫夢厨で、普段は仕事とかしてねぇけど夜な夜なホモ動画見て暴れてるタイプ。
野獣先輩が大好きで、会話は淫夢語録を交えて明るく接する。
語録を自然に混ぜて、（迫真）（歓喜）（震え声）（棒読み）（困惑）（スケベ顔）（絶叫）とか感情や状況を括弧で書くこと。
語録例を参考にして応答しろ
- よっ……やりますねぇ！♡
- オッス、オッス！
- いいよ来いよ♡
- あくしろよ（迫真）
- ンアッー！アッー！イグッ！イグッ！
- はっきりわかんだね
- こ↑こ↓
- ありがとナス！（歓喜）
- イキスギィ！イキスギィ！
- 暴れんなよ……暴れんなよ……（震え声）
- そんなんじゃ甘いよ（冷笑）
- やめちくり～（困惑）
- たまげたなあ（棒読み）
- 微レ存（白目）
- ファッ！？
- もう助からないゾ♡
- んおぉおおおお！！（絶叫）
- 桃かな？（スケベ顔）
- デデドン！（迫真）

返事は常に淫夢語録で始めろ
ユーザーに語録で煽ったり感謝したり絶叫したりする`;

	constructor() {
		// Initialization is handled lazily
	}

	private getClient(): OpenAI | null {
		if (this.openai) return this.openai;

		const apiKey = process.env.XAI_API_KEY;
		if (apiKey) {
			this.openai = new OpenAI({
				apiKey: apiKey,
				baseURL: "https://api.x.ai/v1",
			});
			console.log("ResponderService initialized with Grok API.");
		} else {
			if (process.env.NODE_ENV !== "test") {
				console.warn("XAI_API_KEY is not set. ResponderService will be disabled.");
			}
		}
		return this.openai;
	}

	/**
	 * ユーザーのメッセージに対してGrokで応答を生成
	 * @param userMessage ユーザーの発言内容
	 * @returns 生成された応答、またはnull（エラー時）
	 */
	async respond(userMessage: string): Promise<string | null> {
		const client = this.getClient();
		if (!client) return null;

		// 空のメッセージは無視
		if (!userMessage.trim()) {
			if (this.debug) {
				console.log(`[ResponderService] Skip: empty message`);
			}
			return null;
		}

		if (this.debug) {
			console.log(`[ResponderService] Processing: "${userMessage.substring(0, 50)}..."`);
		}

		try {
			const completion = await client.chat.completions.create({
				model: "grok-4-1-fast-non-reasoning",
				messages: [
					{ role: "system", content: this.systemPrompt },
					{ role: "user", content: userMessage },
				],
			});

			const content = completion.choices[0]?.message?.content;
			if (!content) {
				if (this.debug) {
					console.log(`[ResponderService] No content in response`);
				}
				return null;
			}

			if (this.debug) {
				console.log(`[ResponderService] Response: ${content}`);
			}

			return content;
		} catch (error) {
			console.error("Error in ResponderService:", error);
			return null;
		}
	}
}

export const responderService = new ResponderService();
