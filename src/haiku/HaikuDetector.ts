import kuromoji, { Tokenizer, IpadicFeatures } from 'kuromoji';
import path from 'path';
import { ENGLISH_TO_KATAKANA } from './englishDictionary';

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
	 * アルファベット読み対応表（1文字ずつ読む場合）
	 */
	private static readonly ALPHABET_READINGS: Record<string, string> = {
		'A': 'エー', 'B': 'ビー', 'C': 'シー', 'D': 'ディー', 'E': 'イー',
		'F': 'エフ', 'G': 'ジー', 'H': 'エイチ', 'I': 'アイ', 'J': 'ジェー',
		'K': 'ケー', 'L': 'エル', 'M': 'エム', 'N': 'エヌ', 'O': 'オー',
		'P': 'ピー', 'Q': 'キュー', 'R': 'アール', 'S': 'エス', 'T': 'ティー',
		'U': 'ユー', 'V': 'ブイ', 'W': 'ダブリュー', 'X': 'エックス', 'Y': 'ワイ', 'Z': 'ゼット',
	};

	/**
	 * 数字の読み対応表（単純置換用）
	 */
	private static readonly NUMBER_READINGS: Record<string, string> = {
		'0': 'ゼロ', '1': 'イチ', '2': 'ニ', '3': 'サン', '4': 'ヨン',
		'5': 'ゴ', '6': 'ロク', '7': 'ナナ', '8': 'ハチ', '9': 'キュウ',
		'.': 'テン', '．': 'テン'
	};

	/**
	 * 桁読み用の単位
	 */
	private static readonly DIGIT_UNITS = ['', 'ジュウ', 'ヒャク', 'セン'];
	private static readonly GROUP_UNITS = ['', 'マン', 'オク', 'チョウ', 'ケイ'];

	/**
	 * 整数をカタカナ読みに変換（桁読みあり）
	 */
	private convertIntegerToKatakana(numStr: string): string {
		let num = parseInt(numStr, 10);
		if (isNaN(num)) return numStr;
		if (num === 0) return 'レイ'; // 単独の0はレイ（ユーザー要望）

		let reading = '';
		let groupIndex = 0;

		while (num > 0) {
			const group = num % 10000;
			num = Math.floor(num / 10000);

			if (group > 0) {
				let groupReading = '';
				let temp = group;
				let digitIndex = 0;

				while (temp > 0) {
					const digit = temp % 10;
					temp = Math.floor(temp / 10);

					if (digit > 0) {
						let unit = HaikuDetector.DIGIT_UNITS[digitIndex];
						let digitRead = HaikuDetector.NUMBER_READINGS[String(digit)];

						// 10, 100, 1000 の場合の「イチ」省略ルール
						// 千、百、十 の位で数値が1の場合は「イチ」を読まない（例: 10 -> ジュウ, 1000 -> セン）
						// ただし、1000万などは「イッセンマン」となる場合があるが、ここでは簡易的に「セン」とする
						// ※ 「一千」と読むか「千」と読むかは文脈によるが、俳句ではリズム重視
						if (digit === 1 && digitIndex > 0) {
							// セン、ヒャク、ジュウ
							groupReading = unit + groupReading;
						} else {
							// 300(サンビャク), 600(ロッピャク), 800(ハッピャク) などの音便変化は一旦無しでシンプルに実装
							// 必要に応じて拡張
							groupReading = digitRead + unit + groupReading;
						}
					}
					digitIndex++;
				}
				reading = groupReading + HaikuDetector.GROUP_UNITS[groupIndex] + reading;
			}
			groupIndex++;
		}

		return reading;
	}

	/**
	 * 数字を含むテキストをカタカナ読みに変換
	 * 英単語変換の前に実行する
	 */
	private convertNumberToKatakana(str: string): string {
		// 小数点を含む数値の検索
		// 数字の連続、または 数字.数字 のパターン
		return str.replace(/(\d{1,3}(,\d{3})+)(\.\d+)?|(\d+(\.\d+)?)/g, (match) => {
			// カンマを除去
			const cleanMatch = match.replace(/,/g, '');

			// 小数を含む場合
			if (cleanMatch.includes('.') || cleanMatch.includes('．')) {
				const parts = cleanMatch.split(/[.．]/);
				const integerPart = parts[0];
				const decimalPart = parts[1];

				// 整数部は0の場合は「レイ」、それ以外は桁読み？
				// ユーザー要望「0.1」→「レイテンイチ」
				// 「10.5」→「ジュウテンゴ」
				let result = '';

				// 整数部の処理
				if (integerPart === '0' || integerPart === '') {
					result += 'レイ';
				} else {
					result += this.convertIntegerToKatakana(integerPart);
				}

				result += 'テン';

				// 小数部は棒読み（イチニサン...）
				for (const char of decimalPart) {
					if (HaikuDetector.NUMBER_READINGS[char]) {
						result += HaikuDetector.NUMBER_READINGS[char];
					}
				}
				return result;
			} else {
				// 整数の場合
				return this.convertIntegerToKatakana(cleanMatch);
			}
		});
	}

	/**
	 * 英語テキストをカタカナ読みに変換
	 * 1. 英単語辞書で変換を試みる
	 * 2. 辞書にない場合はアルファベット1文字ずつ読む
	 */
	private convertEnglishToKatakana(str: string): string {
		// 先に数字を変換
		const numConverted = this.convertNumberToKatakana(str);

		// まず全体を小文字にして辞書を検索
		const lower = numConverted.toLowerCase();
		if (ENGLISH_TO_KATAKANA[lower]) {
			return ENGLISH_TO_KATAKANA[lower];
		}

		// 辞書にない場合は1文字ずつアルファベット読み
		// 既にカタカナになっている部分（数字）は除外して置換したいが、
		// 単純なreplaceでも、数字読み（カタカナ）は[A-Za-z]にマッチしないので大丈夫
		return numConverted.replace(/[A-Za-z]/g, match => {
			const upper = match.toUpperCase();
			return HaikuDetector.ALPHABET_READINGS[upper] || match;
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
	 * ペア記号のパターン定義
	 * [開始記号, 終了記号] のペア
	 */
	private static readonly PAIRED_SYMBOLS: Array<[string, string]> = [
		['**', '**'],    // マークダウン太字
		['__', '__'],    // マークダウン太字
		['*', '*'],      // マークダウン斜体
		['_', '_'],      // マークダウン斜体
		['~~', '~~'],    // マークダウン取り消し線
		['`', '`'],      // マークダウンインラインコード
		['"', '"'],      // ダブルクォート
		["'", "'"],      // シングルクォート
		['"', '"'],      // 全角ダブルクォート
		['\u2018', '\u2019'],      // 全角シングルクォート
		['「', '」'],     // 鉤括弧
		['『', '』'],     // 二重鉤括弧
		['【', '】'],     // 墨付き括弧
		['（', '）'],     // 全角丸括弧
		['(', ')'],      // 半角丸括弧
		['[', ']'],      // 半角角括弧
		['〈', '〉'],     // 山括弧
		['《', '》'],     // 二重山括弧
	];

	/**
	 * 未ペアの記号（俳句無効化の対象）
	 */
	private static readonly UNPAIRED_SYMBOL_PATTERN = /[*_~`"'「」『』【】（）()\[\]〈〉《》""'']/;

	/**
	 * ペア記号を処理し、ペアになっている記号は除去、未ペアは残す
	 * @param text 入力テキスト
	 * @returns ペア記号が除去されたテキスト（未ペアは残る）
	 */
	private removePairedSymbols(text: string): string {
		let result = text;

		// 各ペアパターンを処理
		for (const [open, close] of HaikuDetector.PAIRED_SYMBOLS) {
			// 開始と終了が同じ場合（"text"など）
			if (open === close) {
				const escaped = open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				// ペアで囲まれている部分から記号を除去
				const regex = new RegExp(`${escaped}([^${escaped}]+)${escaped}`, 'g');
				result = result.replace(regex, '$1');
			} else {
				// 開始と終了が異なる場合（「text」など）
				const escapedOpen = open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const escapedClose = close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const regex = new RegExp(`${escapedOpen}([^${escapedClose}]*)${escapedClose}`, 'g');
				result = result.replace(regex, '$1');
			}
		}

		return result;
	}

	/**
	 * テキストに未ペアの記号が含まれるかチェック
	 */
	private hasUnpairedSymbols(text: string): boolean {
		return HaikuDetector.UNPAIRED_SYMBOL_PATTERN.test(text);
	}

	/**
	 * テキストを形態素解析し、各トークンの読みとモーラ数を取得
	 */
	private tokenizeWithMorae(text: string): Array<{ surface: string; reading: string; morae: number }> {
		if (!this.tokenizer) {
			throw new Error('HaikuDetector is not initialized. Call initialize() first.');
		}

		const tokens = this.tokenizer.tokenize(text);
		const result: Array<{ surface: string; reading: string; morae: number }> = [];

		let i = 0;
		while (i < tokens.length) {
			const token = tokens[i];

			// 数字トークンの結合処理 (0.1, 1,000 など)
			// kuromojiは数字を細かく分割することがある
			if (/^[\d]+$/.test(token.surface_form)) {
				let mergedSurface = token.surface_form;
				let j = i + 1;
				let merged = false;

				while (j < tokens.length) {
					const next = tokens[j];

					// 次が記号(.,)で、その次が数字の場合 (例: 0.1, 1,000)
					if (/^[.．,]$/.test(next.surface_form)) {
						const nextNext = tokens[j + 1];
						if (nextNext && /^[\d]+$/.test(nextNext.surface_form)) {
							mergedSurface += next.surface_form + nextNext.surface_form;
							j += 2;
							merged = true;
							continue;
						}
					}

					// 単に数字が続く場合 (kuromojiの挙動による)
					if (/^[\d]+$/.test(next.surface_form)) {
						mergedSurface += next.surface_form;
						j++;
						merged = true;
						continue;
					}

					break;
				}

				if (merged) {
					// 結合された数字トークンを処理
					// 読みを数値変換ロジックで生成
					const reading = this.convertNumberToKatakana(mergedSurface);
					result.push({
						surface: mergedSurface,
						reading: reading,
						morae: this.countMorae(reading)
					});
					i = j;
					continue;
				}
			}

			// 通常のトークン処理
			// 読みがない場合は表層形をそのまま使用
			const reading = token.reading || token.surface_form;
			result.push({
				surface: token.surface_form,
				reading,
				morae: this.countMorae(reading)
			});
			i++;
		}

		return result;
	}

	/**
	 * ANSIカラーコード定数
	 */
	private static readonly COLORS = {
		RESET: '\x1b[0m',
		RED: '\x1b[31m',
		GREEN: '\x1b[32m',
		YELLOW: '\x1b[33m',
		BLUE: '\x1b[34m',
		MAGENTA: '\x1b[35m',
		CYAN: '\x1b[36m',
		GRAY: '\x1b[90m',
		BOLD: '\x1b[1m'
	};

	/**
	 * テキストから俳句パターン（5-7-5）を検出
	 * @param text 検索対象のテキスト
	 * @returns 検出された俳句（見つからない場合はnull）
	 */
	async detect(text: string): Promise<HaikuMatch | null> {
		await this.initialize();

		// 24文字を超える場合は俳句とは考えられないため無効
		const cleanedText = text.replace(/[\s\u3000、。！？!?,.]+/g, '');
		if (cleanedText.length > 24) {
			if (this.debug) {
				console.log(`${HaikuDetector.COLORS.GRAY}  [DEBUG] 文字数超過 (${cleanedText.length} > 24) のため無効${HaikuDetector.COLORS.RESET}`);
			}
			return null;
		}

		// ペア記号を処理（**text**や"text"などを除去）
		const processedText = this.removePairedSymbols(text);

		// 未ペアの記号が残っている場合は無効
		if (this.hasUnpairedSymbols(processedText)) {
			if (this.debug) {
				console.log(`${HaikuDetector.COLORS.RED}  [DEBUG] 未ペアの記号が含まれているため無効: "${processedText}"${HaikuDetector.COLORS.RESET}`);
			}
			return null;
		}

		const tokens = this.tokenizeWithMorae(processedText);

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

			console.log(`\n${HaikuDetector.COLORS.CYAN}${HaikuDetector.COLORS.BOLD}  [DEBUG] トークン詳細:${HaikuDetector.COLORS.RESET}`);
			console.log(`  ${HaikuDetector.COLORS.GRAY}┌────────────────┬────────────────┬──────┐${HaikuDetector.COLORS.RESET}`);
			console.log(`  ${HaikuDetector.COLORS.GRAY}│${HaikuDetector.COLORS.RESET} 表層形         ${HaikuDetector.COLORS.GRAY}│${HaikuDetector.COLORS.RESET} 読み           ${HaikuDetector.COLORS.GRAY}│${HaikuDetector.COLORS.RESET}モーラ${HaikuDetector.COLORS.GRAY}│${HaikuDetector.COLORS.RESET}`);
			console.log(`  ${HaikuDetector.COLORS.GRAY}├────────────────┼────────────────┼──────┤${HaikuDetector.COLORS.RESET}`);
			for (const token of tokens) {
				const surface = padToWidth(token.surface, 14);
				const reading = padToWidth(token.reading, 14);
				const morae = String(token.morae).padStart(4);
				console.log(`  ${HaikuDetector.COLORS.GRAY}│${HaikuDetector.COLORS.RESET} ${surface} ${HaikuDetector.COLORS.GRAY}│${HaikuDetector.COLORS.RESET} ${reading} ${HaikuDetector.COLORS.GRAY}│${HaikuDetector.COLORS.YELLOW}${morae}  ${HaikuDetector.COLORS.GRAY}│${HaikuDetector.COLORS.RESET}`);
			}
			console.log(`  ${HaikuDetector.COLORS.GRAY}└────────────────┴────────────────┴──────┘${HaikuDetector.COLORS.RESET}`);
		}

		// 処理後テキストから空白と句読点を除いた文字数
		const originalLength = processedText.replace(/[\s\u3000、。！？!?,.]+/g, '').length;

		if (this.debug) {
			console.log(`${HaikuDetector.COLORS.BLUE}  [DEBUG] 元テキスト文字数（空白・句読点除く）: ${originalLength}${HaikuDetector.COLORS.RESET}`);
		}

		// スライディングウィンドウで5-7-5のパターンを探す
		let startIdx = 0;
		while (startIdx < tokens.length) {
			const { match, nextStartIdx } = this.tryMatchHaiku(tokens, startIdx);

			if (match) {
				// 俳句の文字数と元テキストの文字数が一致する場合のみ有効
				const haikuLength = match.text.replace(/[\s\u3000、。！？!?,.]+/g, '').length;

				if (this.debug) {
					console.log(`${HaikuDetector.COLORS.MAGENTA}  [DEBUG] 候補発見 (startIdx=${startIdx}): "${match.text}"${HaikuDetector.COLORS.RESET}`);
					console.log(`  [DEBUG]   俳句文字数: ${haikuLength}, 元文字数: ${originalLength}`);
				}

				if (haikuLength === originalLength) {
					if (this.debug) {
						console.log(`${HaikuDetector.COLORS.GREEN}${HaikuDetector.COLORS.BOLD}  [DEBUG]   → 有効な俳句として採用${HaikuDetector.COLORS.RESET}`);
					}
					// 俳句を返す（スキャン終了）
					return match;
				} else {
					if (this.debug) {
						console.log(`${HaikuDetector.COLORS.RED}  [DEBUG]   → 文字数不一致のため無効${HaikuDetector.COLORS.RESET}`);
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
			console.log(`\n${HaikuDetector.COLORS.CYAN}${HaikuDetector.COLORS.BOLD}  [DEBUG] 5-7-5パターン探索開始...${HaikuDetector.COLORS.RESET}`);
		}

		// 上の句（5音）を探す
		const kami = this.findPhrase(tokens, startIdx, 5, '上の句');
		if (!kami) {
			if (this.debug && startIdx === 0) {
				// 最初の探索で見つからない場合のみログ出力（以後はノイズになるため省略）
				// findPhrase内で詳細が出ているのでここではシンプルに
			}
			return { match: null, nextStartIdx: startIdx + 1 };
		}

		// 中の句（7音）を探す
		const naka = this.findPhrase(tokens, kami.endIdx + 1, 7, '中の句');
		if (!naka) {
			if (this.debug) {
				console.log(`  ${HaikuDetector.COLORS.GRAY}└── [DEBUG] 中の句(7音)不成立 → 次のスキャン位置: ${kami.endIdx + 1}${HaikuDetector.COLORS.RESET}`);
			}
			// 上の句は見つかったので、次は上の句の終了位置+1から開始
			return { match: null, nextStartIdx: kami.endIdx + 1 };
		}

		// 下の句（5音）を探す
		const shimo = this.findPhrase(tokens, naka.endIdx + 1, 5, '下の句');
		if (!shimo) {
			if (this.debug) {
				console.log(`  ${HaikuDetector.COLORS.GRAY}└── [DEBUG] 下の句(5音)不成立 → 次のスキャン位置: ${naka.endIdx + 1}${HaikuDetector.COLORS.RESET}`);
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
			console.log(`  ${HaikuDetector.COLORS.GRAY}├──${HaikuDetector.COLORS.RESET} 🔍 ${HaikuDetector.COLORS.CYAN}${HaikuDetector.COLORS.BOLD}${phraseName}(${targetMorae}音)${HaikuDetector.COLORS.RESET} 探索開始 (index: ${startIdx})`);
		}

		let text = '';
		let combinedReading = '';
		let actualStartIdx = startIdx;

		// 開始位置の句読点・空白をスキップ
		while (actualStartIdx < tokens.length) {
			const token = tokens[actualStartIdx];
			if (/^[\s\u3000、。！？!?,.]+$/.test(token.surface)) {
				if (this.debug) {
					console.log(`  ${HaikuDetector.COLORS.GRAY}│   ├── [${actualStartIdx}] "${token.surface}" → Skip (句頭記号)${HaikuDetector.COLORS.RESET}`);
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
					console.log(`  ${HaikuDetector.COLORS.GRAY}│   ├── ${HaikuDetector.COLORS.RED}❌ [${i}] "${token.surface}" : 句読点割り込み${HaikuDetector.COLORS.RESET}`);
				}
				return null;
			}

			// 記号が含まれている場合は無効
			// ただし、数値のみで構成されるトークン（0.1など）は許可
			const isNumberToken = /^[\d.,]+$/.test(token.surface);
			if (!isNumberToken && HaikuDetector.INVALID_SYMBOL_PATTERN.test(token.surface)) {
				if (this.debug) {
					console.log(`  ${HaikuDetector.COLORS.GRAY}│   ├── ${HaikuDetector.COLORS.RED}❌ [${i}] "${token.surface}" : 禁止記号${HaikuDetector.COLORS.RESET}`);
				}
				return null;
			}

			// テキストと読みを連結（アルファベットはカタカナ読みに変換）
			text += token.surface;
			const reading = this.hiraganaToKatakana(token.reading || token.surface);
			combinedReading += this.convertEnglishToKatakana(reading);

			// 連結した読みでモーラカウント（終端処理なし）
			const currentMorae = this.countMoraeRaw(combinedReading);

			// 句の終端判定（二重母音調整を含む）
			const isMatch = currentMorae === targetMorae;
			const isDiphthongMatch = currentMorae === targetMorae + 1 && this.endsWithDiphthong(combinedReading);

			if (isMatch || isDiphthongMatch) {
				if (this.debug) {
					// 最後のトークンの累積ログも出力
					console.log(`  ${HaikuDetector.COLORS.GRAY}│   ├── [${i}] "${token.surface}" : 累積「${combinedReading}」= ${currentMorae}音${HaikuDetector.COLORS.RESET}`);

					let extraInfo = '';
					if (isDiphthongMatch) {
						extraInfo = ` ${HaikuDetector.COLORS.MAGENTA}(二重母音調整 -1)${HaikuDetector.COLORS.RESET}`;
					}
					// 探索ログと区別するために空行を入れるか、フォーマットを変える
					console.log(`  ${HaikuDetector.COLORS.GRAY}│${HaikuDetector.COLORS.RESET}`);
					console.log(`  ${HaikuDetector.COLORS.GRAY}│${HaikuDetector.COLORS.RESET}   ${HaikuDetector.COLORS.GREEN}${HaikuDetector.COLORS.BOLD}✨ ${phraseName}検出: "${text}"${HaikuDetector.COLORS.RESET} (計${currentMorae}音)${extraInfo}`);
				}

				// 次のトークンが長音・促音・撥音で始まる場合はマージ
				const nextToken = tokens[i + 1];
				if (nextToken && !/^[\s\u3000、。！？!?,.]+$/.test(nextToken.surface)) {
					const nextReading = this.hiraganaToKatakana(nextToken.reading || nextToken.surface);
					const firstChar = [...nextReading][0];
					if (firstChar && 'ーンッ'.includes(firstChar)) {
						if (this.debug) {
							console.log(`  ${HaikuDetector.COLORS.GRAY}│       ⚠️ 次トークン"${nextToken.surface}"(${firstChar})をマージ必要${HaikuDetector.COLORS.RESET}`);
						}
						continue;
					}
				}
				return { text, endIdx: i };
			}

			if (this.debug) {
				// 進行中ログ
				if (currentMorae <= targetMorae + 1) {
					console.log(`  ${HaikuDetector.COLORS.GRAY}│   ├── [${i}] "${token.surface}" : 累積「${combinedReading}」= ${currentMorae}音${HaikuDetector.COLORS.RESET}`);
				}
			}

			if (currentMorae > targetMorae + 1) {
				if (this.debug) {
					console.log(`  ${HaikuDetector.COLORS.GRAY}│   └── ${HaikuDetector.COLORS.RED}❌ [${i}] "${token.surface}" : モーラ超過 (${currentMorae} > ${targetMorae})${HaikuDetector.COLORS.RESET}`);
				}
				return null;
			}

			if (currentMorae === targetMorae + 1 && !this.endsWithDiphthong(combinedReading)) {
				if (this.debug) {
					console.log(`  ${HaikuDetector.COLORS.GRAY}│   └── ${HaikuDetector.COLORS.RED}❌ [${i}] "${token.surface}" : モーラ超過・二重母音なし (${currentMorae} > ${targetMorae})${HaikuDetector.COLORS.RESET}`);
				}
				return null;
			}
		}

		if (this.debug) {
			console.log(`  ${HaikuDetector.COLORS.GRAY}│   └── ⚠️ トークン終端により未完成${HaikuDetector.COLORS.RESET}`);
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
