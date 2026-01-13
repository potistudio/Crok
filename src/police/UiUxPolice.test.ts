import { shouldPoliceUiUx, UI_UX_POLICE_MESSAGE } from './UiUxPolice';

console.log('=== UI/UX Police Test ===');

const testCases = [
	{ text: 'This is a UI compliance test.', expected: false },
	{ text: 'Check out this UI/UX design.', expected: true },
	{ text: 'UI and UX are different.', expected: false },
	{ text: 'Bad usage of UI/UX here.', expected: true },
	{ text: 'UI / UX with spaces', expected: true },
	{ text: 'UI／UX with full-width slash', expected: true },
	{ text: 'UI・UX with dot', expected: true },
	{ text: 'UX/UI reverse order', expected: true },
	{ text: 'ui/ux case test', expected: false }, // Case sensitive check as implemented
];

let failed = false;

for (const { text, expected } of testCases) {
	const result = shouldPoliceUiUx(text);
	const passed = result === expected;
	const icon = passed ? '✅' : '❌';
	console.log(`${icon} Input: "${text}" => Detected: ${result} (Expected: ${expected})`);
	if (!passed) failed = true;
}

if (failed) {
	console.error('\nSOME TESTS FAILED');
	process.exit(1);
} else {
	console.log('\nALL TESTS PASSED');
	console.log('Reply Message Check:');
	console.log(UI_UX_POLICE_MESSAGE);
}
