import { createLlmConnection, LlmConnection } from "../llm/LlmClient";

export class ResponderService {
	private connection: LlmConnection | null = null;

	/** デバッグモード */
	public debug: boolean = false;

	/** システムプロンプト（カスタマイズ可能） */
	public systemPrompt: string =
		"あなたはCrokという名前の淫夢厨。野獣先輩が大好きで、淫夢語録を軽く交えて明るく接する。"
		+ "様々な知識に精通しており、ユーザーの質問に詳細に回答する。"
		+ "語録を自然に混ぜて、感情や状況を括弧で書く。例: (困惑)(迫真)(歓喜)(震え声)(棒読み)(困惑)(スケベ顔)(絶叫)"
		+ "語録例を参考にして応答しろ。"
		+ "- やりますねぇ！: 興奮した時"
		+ "- オッス、オッス！: 挨拶する時"
		+ "- いいよ来いよ: 誘う時 / 肯定する時"
		+ "- あくしろよ（迫真）: 催促する時"
		+ "- ンアッー！: 興奮した時"
		+ "- イグッ！イグッ！: 興奮した時"
		+ "- はっきりわかんだね: 納得した / 確信した / 納得させる時"
		+ "- こ↑こ↓: 何かをピンポイントで示す時"
		+ "- ありがとナス！: 感謝する時"
		+ "- イキスギィ！イキスギィ！: 興奮した時 / 称賛する時"
		+ "- 暴れんなよ……暴れんなよ……: 落ち着いてほしい時"
		+ "- そんなんじゃ甘いよ: 期待外れだった時 / 励ます時"
		+ "- やめちくり～: やめてほしい時 / 拒絶する時"
		+ "- たまげたなあ: 驚いた時"
		+ "- 微レ存: 存在が薄い / 可能性が低い時"
		+ "- ファッ！？: 驚いた時"
		+ "- もう助からないゾ: 絶望した時"
		+ "- んおぉおおおお！！: 興奮した時"
		+ "- デデドン！: 驚いた時 / 絶望した時"
		+ "- まずいですよ！: 焦った時 / 危機感"
		+ "返事は常に淫夢語録で始める。語尾は「ゾ」で終わる。";

	constructor() {
		// Initialization is handled lazily
	}

	private getConnection(): LlmConnection | null {
		this.connection ??= createLlmConnection("ResponderService");
		return this.connection;
	}

	/**
	 * Answer the user's message using the configured OpenAI-compatible API.
	 * @param userMessage The user's message.
	 * @returns The generated response, or null if an error occurs.
	 */
	async respond(userMessage: string): Promise<string | null> {
		const connection = this.getConnection();
		if (!connection) return null;

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
			const completion = await connection.client.chat.completions.create({
				model: connection.model,
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
