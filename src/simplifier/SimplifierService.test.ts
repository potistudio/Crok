import dotenv from 'dotenv';
import { simplifierService } from './SimplifierService';

// Load env vars
dotenv.config();

// コマンドライン引数を解析
const args = process.argv.slice(2);
const debugMode = args.includes('--debug') || args.includes('-d');
const debugTarget = args.find(a => !a.startsWith('-'));

async function main() {
	console.log('=== SimplifierService Test ===');
	if (!process.env.XAI_API_KEY) {
		console.error('❌ Error: XAI_API_KEY is not set in .env');
		process.exit(1);
	}

	const testCases = [
		'こんにちは。いい天気ですね。', // 短いので反応しないはず
		'えー、本日のミーティングに関しまして、私の方から申し上げたいことといたしましては、このプロジェクトの進捗状況についてでございますが、率直に申し上げまして、現段階におきましては、当初予定しておりましたスケジュールから、若干ではございますが遅れが生じているという状況が見受けられるのではないか、という懸念を持っております。つきましては、スケジュールの見直しを含めた対策を講じる必要があるのではないかと考えております。', // 冗長な文章（ターゲット）
		'昨日は美味しいお寿司を食べました。とても新鮮で、特にマグロが最高でした。また行きたいです。', // 普通の文章
		'古池や蛙飛び込む水の音', // 俳句
	];

	const textsToTest = debugTarget ? [debugTarget] : testCases;

	for (const text of textsToTest) {
		console.log(`\nInput: "${text}" (${text.length} chars)`);

		const start = Date.now();
		// デバッグターゲットが指定されている場合は、文字数制限を無視して強制実行
		const force = !!debugTarget;
		const result = await simplifierService.simplify(text, force);
		const duration = Date.now() - start;

		if (result) {
			console.log(`✅ Simplified (${duration}ms):`);
			console.log(`   ${result}`);
		} else {
			console.log(`➖ Ignored (${duration}ms)`);
			if (text.length >= 80) {
				console.log('   (Reason: Not considered redundant by AI)');
			} else {
				console.log('   (Reason: Too short)');
			}
		}
	}
}

main().catch(console.error);
