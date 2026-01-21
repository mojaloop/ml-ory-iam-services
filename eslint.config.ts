import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
      'quote-props': ['error', 'as-needed'],
      quotes: ['error', 'single', { allowTemplateLiterals: true }],
      indent: ['error', 2, { SwitchCase: 1 }],
      semi: ['error'],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  }
);
