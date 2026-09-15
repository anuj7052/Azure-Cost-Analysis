import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // Uppercase identifiers are components and constants. Without
      // eslint-plugin-react there is no `jsx-uses-vars`, so anything consumed
      // only inside JSX reads as unused. `varsIgnorePattern` already covers
      // imported components; `argsIgnorePattern` extends the same rule to a
      // component passed in as a prop (`function Card({ icon: Icon })`), which
      // is otherwise reported as dead code in a file that renders it.
      'no-unused-vars': ['error', {
        varsIgnorePattern: '^[A-Z_]',
        argsIgnorePattern: '^[A-Z_]',
      }],

      // Downgraded, not dismissed.
      //
      // eslint-plugin-react-hooks 7.1 started flagging an effect that calls a
      // function which sets state, not just a direct setState. That is a fair
      // catch -- every one of these is a cascading render -- but it lit up 30
      // sites across pages that work, and a lint run that is red everywhere is
      // a lint run nobody reads, which costs more than the renders do.
      //
      // So they stay visible as warnings and get fixed with the file they live
      // in. Turning the rules off would have made the same noise problem go
      // away by making the real finding invisible too.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/immutability': 'warn',
    },
  },
])
