
import { describe, it, expect } from 'vitest';
import { shouldPoliceUiUx, UI_UX_POLICE_MESSAGE } from './UiUxPolice';

describe('UI/UX Police', () => {
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

	it.each(testCases)('should return $expected for "$text"', ({ text, expected }) => {
		expect(shouldPoliceUiUx(text)).toBe(expected);
	});

	it('should have the correct police message', () => {
		expect(UI_UX_POLICE_MESSAGE).toContain('UIとUXは似て非なる概念');
	});
});
