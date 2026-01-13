import kuromoji, { Tokenizer, IpadicFeatures } from 'kuromoji';
import path from 'path';

/**
 * 俳句検出結果
 */
export interface HaikuMatch {
	/** 検出された俳句のテキスト全体 */
	text: string;
	/** 上の句（5音） */
	kami: string;
	/** 中の句（7音） */
	naka: string;
	/** 下の句（5音） */
	shimo: string;
	/** 各句のモーラ数 */
	morae: [number, number, number];
}

/**
 * 俳句検出クラス
 * 与えられた日本語テキストから5-7-5のパターンを検出します
 */
export class HaikuDetector {
	private tokenizer: Tokenizer<IpadicFeatures> | null = null;
	private initPromise: Promise<void> | null = null;

	/** デバッグモード */
	public debug: boolean = false;

	/**
	 * 形態素解析器を初期化
	 */
	async initialize(): Promise<void> {
		if (this.tokenizer) return;
		if (this.initPromise) return this.initPromise;

		this.initPromise = new Promise((resolve, reject) => {
			// kuromoji辞書のパスを解決
			const dicPath = path.join(
				path.dirname(require.resolve('kuromoji')),
				'../dict'
			);

			kuromoji.builder({ dicPath }).build((err, tokenizer) => {
				if (err) {
					reject(err);
					return;
				}
				this.tokenizer = tokenizer;
				resolve();
			});
		});

		return this.initPromise;
	}

	/**
	 * カタカナをひらがなに変換
	 */
	private katakanaToHiragana(str: string): string {
		return str.replace(/[\u30A1-\u30F6]/g, match => {
			return String.fromCharCode(match.charCodeAt(0) - 0x60);
		});
	}

	/**
	 * ひらがなをカタカナに変換
	 */
	private hiraganaToKatakana(str: string): string {
		return str.replace(/[\u3041-\u3096]/g, match => {
			return String.fromCharCode(match.charCodeAt(0) + 0x60);
		});
	}

	/**
	 * アルファベット読み対応表
	 */
	private static readonly ALPHABET_READINGS: Record<string, string> = {
		'A': 'エー', 'B': 'ビー', 'C': 'シー', 'D': 'ディー', 'E': 'イー',
		'F': 'エフ', 'G': 'ジー', 'H': 'エイチ', 'I': 'アイ', 'J': 'ジェー',
		'K': 'ケー', 'L': 'エル', 'M': 'エム', 'N': 'エヌ', 'O': 'オー',
		'P': 'ピー', 'Q': 'キュー', 'R': 'アール', 'S': 'エス', 'T': 'ティー',
		'U': 'ユー', 'V': 'ブイ', 'W': 'ダブリュー', 'X': 'エックス', 'Y': 'ワイ', 'Z': 'ゼット',
		'a': 'エー', 'b': 'ビー', 'c': 'シー', 'd': 'ディー', 'e': 'イー',
		'f': 'エフ', 'g': 'ジー', 'h': 'エイチ', 'i': 'アイ', 'j': 'ジェー',
		'k': 'ケー', 'l': 'エル', 'm': 'エム', 'n': 'エヌ', 'o': 'オー',
		'p': 'ピー', 'q': 'キュー', 'r': 'アール', 's': 'エス', 't': 'ティー',
		'u': 'ユー', 'v': 'ブイ', 'w': 'ダブリュー', 'x': 'エックス', 'y': 'ワイ', 'z': 'ゼット',
	};

	/**
	 * アルファベットをカタカナ読みに変換
	 */
	private convertAlphabetToKatakana(str: string): string {
		return str.replace(/[A-Za-z]/g, match => {
			return HaikuDetector.ALPHABET_READINGS[match] || match;
		});
	}

	/**
	 * 二重母音パターン（実際の発話で1モーラに近くなる）
	 * 〜アイ、〜オイ、〜ウイ、〜エイ、〜オウ など
	 */
	private static readonly DIPHTHONG_ENDINGS = ['アイ', 'オイ', 'ウイ', 'エイ', 'オウ', 'アウ'];

	/**
	 * 読み仮名からモーラ数をカウント
	 * @param reading カタカナまたはひらがなの読み
	 * @param adjustDiphthong 終端の二重母音を1モーラとして扱うか（デフォルト: true）
	 */
	countMorae(reading: string, adjustDiphthong: boolean = true): number {
		if (!reading) return 0;

		// カタカナに統一して処理
		const katakana = this.hiraganaToKatakana(reading);

		let count = 0;
		const chars = [...katakana];

		for (let i = 0; i < chars.length; i++) {
			const char = chars[i];

			// 小書き文字（拗音）は前の文字と合わせて1モーラ
			if ('ァィゥェォャュョヮぁぃぅぇぉゃゅょゎ'.includes(char)) {
				// 単独で出現した場合は1モーラとしてカウント
				if (i === 0) count++;
				// それ以外は前の文字に含まれる
				continue;
			}

			// 長音、撥音、促音は1モーラ（ただし、句の終端にある場合は無視）
			if ('ーンッんっ'.includes(char)) {
				if (i < chars.length - 1) {
					count++;
				}
				continue;
			}

			// 漢字やカタカナ・ひらがな以外の文字はスキップ
			if (!/[\u30A0-\u30FF\u3040-\u309F]/.test(char)) {
				continue;
			}

			// 通常の文字は1モーラ
			count++;
		}

		// 終端の二重母音を1モーラとして調整
		if (adjustDiphthong && katakana.length >= 2) {
			const lastTwo = katakana.slice(-2);
			// 二重母音パターンに一致する場合、1モーラ減らす
			for (const diphthong of HaikuDetector.DIPHTHONG_ENDINGS) {
				if (lastTwo.endsWith(diphthong.slice(-2))) {
					// 最後の2文字が母音+半母音のパターンか確認
					const secondLast = lastTwo[0];
					const last = lastTwo[1];
					// 母音チェック（ア行の文字）
					if ('アイウエオ'.includes(last) && !'アイウエオ'.includes(secondLast)) {
						// 前の文字が子音+母音、最後が母音の場合（例：ナイ、タイ、カイ）
						count--;
						break;
					}
				}
			}
		}

		return count;
	}

	/**
	 * 読みが終端調整の対象かどうかを判定
	 * - 二重母音（〜アイ、〜オイ等）: 実際の発話で1モーラに近くなる
	 * - 終端の撥音「ン」: 実際の発話で消滅して前の音とマージされる
	 */
	private endsWithDiphthong(reading: string): boolean {
		if (!reading || reading.length < 2) return false;

		const katakana = this.hiraganaToKatakana(reading);
		const last = katakana.slice(-1);
		const lastTwo = katakana.slice(-2);

		// 終端が撥音「ン」の場合は調整対象
		if (last === 'ン') {
			return true;
		}

		const secondLast = lastTwo[0];
		const lastChar = lastTwo[1];

		// 最後が母音で、その前が子音+母音の場合（例：ナイ、タイ、カイ）
		return 'アイウエオ'.includes(lastChar) && !'アイウエオ'.includes(secondLast);
	}

	/**
	 * テキストを形態素解析し、各トークンの読みとモーラ数を取得
	 */
	private tokenizeWithMorae(text: string): Array<{ surface: string; reading: string; morae: number }> {
		if (!this.tokenizer) {
			throw new Error('HaikuDetector is not initialized. Call initialize() first.');
		}

		const tokens = this.tokenizer.tokenize(text);
		return tokens.map(token => {
			// 読みがない場合は表層形をそのまま使用
			const reading = token.reading || token.surface_form;
			return {
				surface: token.surface_form,
				reading,
				morae: this.countMorae(reading)
			};
		});
	}

	/**
	 * テキストから俳句パターン（5-7-5）を検出
	 * @param text 検索対象のテキスト
	 * @returns 検出された俳句（見つからない場合はnull）
	 */
	async detect(text: string): Promise<HaikuMatch | null> {
		await this.initialize();

		const tokens = this.tokenizeWithMorae(text);

		if (tokens.length === 0) return null;

		// デバッグ: トークン詳細を出力
		if (this.debug) {
			// 文字の表示幅を計算（全角=2, 半角=1）
			const getDisplayWidth = (str: string): number => {
				let width = 0;
				for (const char of str) {
					const code = char.charCodeAt(0);
					// 全角文字（CJK、全角記号、カタカナ、ひらがな等）
					if ((code >= 0x3000 && code <= 0x9FFF) ||
						(code >= 0xFF00 && code <= 0xFFEF) ||
						(code >= 0x30A0 && code <= 0x30FF) ||
						(code >= 0x3040 && code <= 0x309F)) {
						width += 2;
					} else {
						width += 1;
					}
				}
				return width;
			};

			// 表示幅を考慮したパディング
			const padToWidth = (str: string, targetWidth: number): string => {
				const currentWidth = getDisplayWidth(str);
				if (currentWidth >= targetWidth) return str;
				return str + ' '.repeat(targetWidth - currentWidth);
			};

			console.log('\n  [DEBUG] トークン詳細:');
			console.log('  ┌────────────────┬────────────────┬──────┐');
			console.log('  │ 表層形         │ 読み           │モーラ│');
			console.log('  ├────────────────┼────────────────┼──────┤');
			for (const token of tokens) {
				const surface = padToWidth(token.surface, 14);
				const reading = padToWidth(token.reading, 14);
				const morae = String(token.morae).padStart(4);
				console.log(`  │ ${surface} │ ${reading} │${morae}  │`);
			}
			console.log('  └────────────────┴────────────────┴──────┘');
		}

		// 元テキストから空白と句読点を除いた文字数
		const originalLength = text.replace(/[\s\u3000、。！？!?,.]+/g, '').length;

		if (this.debug) {
			console.log(`  [DEBUG] 元テキスト文字数（空白・句読点除く）: ${originalLength}`);
		}

		// スライディングウィンドウで5-7-5のパターンを探す
		let startIdx = 0;
		while (startIdx < tokens.length) {
			const { match, nextStartIdx } = this.tryMatchHaiku(tokens, startIdx);

			if (match) {
				// 俳句の文字数と元テキストの文字数が一致する場合のみ有効
				const haikuLength = match.text.replace(/[\s\u3000]/g, '').length;

				if (this.debug) {
					console.log(`  [DEBUG] 候補発見 (startIdx=${startIdx}): "${match.text}"`);
					console.log(`  [DEBUG]   俳句文字数: ${haikuLength}, 元文字数: ${originalLength}`);
				}

				if (haikuLength === originalLength) {
					if (this.debug) {
						console.log(`  [DEBUG]   → 有効な俳句として採用`);
					}
					// 俳句を返す（スキャン終了）
					return match;
				} else {
					if (this.debug) {
						console.log(`  [DEBUG]   → 文字数不一致のため無効`);
					}
				}
			}

			// 次のスキャン開始位置へスキップ
			startIdx = nextStartIdx;
		}

		return null;
	}

	/**
	 * 指定位置から5-7-5のパターンにマッチするか試行
	 * @returns マッチした俳句と、次のスキャン開始位置（上の句が見つかった場合はその終了位置+1）
	 */
	private tryMatchHaiku(
		tokens: Array<{ surface: string; reading: string; morae: number }>,
		startIdx: number
	): { match: HaikuMatch | null; nextStartIdx: number } {
		if (this.debug && startIdx === 0) {
			console.log(`\n  [DEBUG] 5-7-5パターン探索開始...`);
		}

		// 上の句（5音）を探す
		const kami = this.findPhrase(tokens, startIdx, 5, '上の句');
		if (!kami) {
			if (this.debug && startIdx === 0) {
				console.log(`  [DEBUG] startIdx=${startIdx}: 上の句(5音)が見つからず終了`);
			}
			return { match: null, nextStartIdx: startIdx + 1 };
		}

		// 中の句（7音）を探す
		const naka = this.findPhrase(tokens, kami.endIdx + 1, 7, '中の句');
		if (!naka) {
			if (this.debug) {
				console.log(`  [DEBUG] startIdx=${startIdx}: 中の句(7音)が見つからず終了`);
				console.log(`  [DEBUG]   → 次のスキャンは位置${kami.endIdx + 1}から開始`);
			}
			// 上の句は見つかったので、次は上の句の終了位置+1から開始
			return { match: null, nextStartIdx: kami.endIdx + 1 };
		}

		// 下の句（5音）を探す
		const shimo = this.findPhrase(tokens, naka.endIdx + 1, 5, '下の句');
		if (!shimo) {
			if (this.debug) {
				console.log(`  [DEBUG] startIdx=${startIdx}: 下の句(5音)が見つからず終了`);
				console.log(`  [DEBUG]   → 次のスキャンは位置${naka.endIdx + 1}から開始`);
			}
			// 中の句まで見つかったので、次は中の句の終了位置+1から開始
			return { match: null, nextStartIdx: naka.endIdx + 1 };
		}

		const match: HaikuMatch = {
			text: kami.text + naka.text + shimo.text,
			kami: kami.text,
			naka: naka.text,
			shimo: shimo.text,
			morae: [5, 7, 5]
		};
		return { match, nextStartIdx: shimo.endIdx + 1 };
	}

	/**
	 * 記号パターン（俳句として無効とみなすもの）
	 * - URL、メンション、絵文字コード、括弧、句読点、引用符など
	 */
	private static readonly INVALID_SYMBOL_PATTERN = /[#@:/\\<>{}[\]()（）「」『』【】、。，．,.!！?？;；:：'"'""`・\uD800-\uDFFF]|https?|www\./;

	/**
	 * 指定位置から指定モーラ数のフレーズを探す
	 * トークンの読みを連結してからモーラカウントを行う（トークン境界の影響を排除）
	 */
	private findPhrase(
		tokens: Array<{ surface: string; reading: string; morae: number }>,
		startIdx: number,
		targetMorae: number,
		phraseName: string = ''
	): { text: string; endIdx: number } | null {
		if (this.debug) {
			console.log(`  [DEBUG] ${phraseName}(${targetMorae}音)探索中... startIdx=${startIdx}`);
		}

		let text = '';
		let combinedReading = '';
		let actualStartIdx = startIdx;

		// 開始位置の句読点・空白をスキップ
		while (actualStartIdx < tokens.length) {
			const token = tokens[actualStartIdx];
			if (/^[\s\u3000、。！？!?,.]+$/.test(token.surface)) {
				if (this.debug) {
					console.log(`  [DEBUG]   [${actualStartIdx}] "${token.surface}" → スキップ（句の開始位置）`);
				}
				actualStartIdx++;
			} else {
				break;
			}
		}

		for (let i = actualStartIdx; i < tokens.length; i++) {
			const token = tokens[i];

			// 句の途中に句読点が割り込む場合は無効
			if (/^[\s\u3000、。！？!?,.]+$/.test(token.surface)) {
				if (this.debug) {
					console.log(`  [DEBUG]   [${i}] "${token.surface}" → 無効（句の途中に句読点）`);
				}
				return null;
			}

			// 記号が含まれている場合は無効
			if (HaikuDetector.INVALID_SYMBOL_PATTERN.test(token.surface)) {
				if (this.debug) {
					console.log(`  [DEBUG]   [${i}] "${token.surface}" → 無効（禁止記号を含む）`);
				}
				return null;
			}

			// テキストと読みを連結（アルファベットはカタカナ読みに変換）
			text += token.surface;
			const reading = this.hiraganaToKatakana(token.reading || token.surface);
			combinedReading += this.convertAlphabetToKatakana(reading);

			// 連結した読みでモーラカウント（終端処理なし）
			const currentMorae = this.countMoraeRaw(combinedReading);

			if (this.debug) {
				console.log(`  [DEBUG]   [${i}] "${token.surface}" → 連結読み「${combinedReading}」= ${currentMorae}音`);
			}

			// 句の終端判定（二重母音調整を含む）
			const isMatch = currentMorae === targetMorae;
			const isDiphthongMatch = currentMorae === targetMorae + 1 && this.endsWithDiphthong(combinedReading);

			if (isMatch || isDiphthongMatch) {
				if (isDiphthongMatch && this.debug) {
					console.log(`  [DEBUG]   → 終端の二重母音を調整 (${currentMorae}音 → ${targetMorae}音相当)`);
				}

				// 次のトークンが長音・促音・撥音で始まる場合はマージ
				const nextToken = tokens[i + 1];
				if (nextToken && !/^[\s\u3000、。！？!?,.]+$/.test(nextToken.surface)) {
					const nextReading = this.hiraganaToKatakana(nextToken.reading || nextToken.surface);
					const firstChar = [...nextReading][0];
					if (firstChar && 'ーンッ'.includes(firstChar)) {
						if (this.debug) {
							console.log(`  [DEBUG]   → 次のトークン"${nextToken.surface}"が長音/促音/撥音で始まるためマージ`);
						}
						continue;
					}
				}

				if (this.debug) {
					console.log(`  [DEBUG]   → ${phraseName}完成: "${text}"`);
				}
				return { text, endIdx: i };
			}

			if (currentMorae > targetMorae + 1) {
				if (this.debug) {
					console.log(`  [DEBUG]   → モーラ超過(${currentMorae} > ${targetMorae})のため無効`);
				}
				return null;
			}

			if (currentMorae === targetMorae + 1 && !this.endsWithDiphthong(combinedReading)) {
				if (this.debug) {
					console.log(`  [DEBUG]   → モーラ超過(${currentMorae} > ${targetMorae})、二重母音なしのため無効`);
				}
				return null;
			}
		}

		if (this.debug) {
			console.log(`  [DEBUG]   → トークン終端に到達、${phraseName}未完成`);
		}
		return null;
	}

	/**
	 * 読み仮名からモーラ数をカウント（終端処理なし、連結用）
	 */
	private countMoraeRaw(reading: string): number {
		if (!reading) return 0;

		const katakana = this.hiraganaToKatakana(reading);
		let count = 0;
		const chars = [...katakana];

		for (let i = 0; i < chars.length; i++) {
			const char = chars[i];

			// 小書き文字（拗音）は前の文字と合わせて1モーラ
			if ('ァィゥェォャュョヮ'.includes(char)) {
				if (i === 0) count++;
				continue;
			}

			// 長音、撥音、促音は常に1モーラ（連結なので終端無視しない）
			if ('ーンッ'.includes(char)) {
				count++;
				continue;
			}

			// カタカナ以外の文字はスキップ
			if (!/[\u30A0-\u30FF]/.test(char)) {
				continue;
			}

			count++;
		}

		return count;
	}

	/**
	 * テキストが俳句かどうかを判定
	 * @param text チェック対象のテキスト
	 * @returns 俳句であればtrue
	 */
	async isHaiku(text: string): Promise<boolean> {
		const match = await this.detect(text);
		return match !== null;
	}

	/**
	 * テキストの総モーラ数を取得
	 * @param text 対象テキスト
	 */
	async getTotalMorae(text: string): Promise<number> {
		await this.initialize();
		const tokens = this.tokenizeWithMorae(text);
		return tokens.reduce((sum, t) => sum + t.morae, 0);
	}
}

// シングルトンインスタンスをエクスポート
export const haikuDetector = new HaikuDetector();

/**
 * 便利な関数：テキストから俳句を検出
 */
export async function detectHaiku(text: string): Promise<HaikuMatch | null> {
	return haikuDetector.detect(text);
}

/**
 * 便利な関数：テキストが俳句かどうか判定
 */
export async function isHaiku(text: string): Promise<boolean> {
	return haikuDetector.isHaiku(text);
}
