import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

// Keep API compatibility tied to manifest.json; declaration packages live in node_modules.
export default [
  { ignores: ['node_modules/**', 'dist/**', 'backups/**', '.testvault/**', '.testprofile/**', 'docs/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { obsidianmd },
    rules: { 'obsidianmd/no-unsupported-api': 'error' },
  },
];
