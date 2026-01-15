import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import { includeIgnoreFile } from "@eslint/compat";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gitignorePath = path.resolve(__dirname, ".gitignore");

export default [
	// 1. Ignore files from .gitignore
	includeIgnoreFile(gitignorePath),

	// 2. Base Javascript Configuration
	{
		files: ["**/*.{js,mjs,cjs,ts}"],
		languageOptions: {
			globals: globals.node,
		},
	},

	// 3. Recommended JS Rules
	pluginJs.configs.recommended,

	// 4. TypeScript Configuration with Type Checking
	...tseslint.configs.recommendedTypeChecked,

	{
		languageOptions: {
			parserOptions: {
				project: "./tsconfig.eslint.json",
				tsconfigRootDir: __dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error",
		},
	},

	// 5. Prettier Config (must be last to override other rules)
	eslintConfigPrettier,
];
