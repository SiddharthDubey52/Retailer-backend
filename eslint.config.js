import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['node_modules/**'] },
  {
    files: ['**/*.js'],
    ...js.configs.recommended,
    languageOptions: { globals: globals.node },
  },
]
