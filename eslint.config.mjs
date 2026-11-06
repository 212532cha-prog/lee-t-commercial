import globals from 'globals';
const rules={
 'no-undef':'error',
 'no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_',caughtErrors:'none'}],
 'no-unreachable':'error',
 'no-constant-condition':'error',
};
export default [
 {ignores:['node_modules/**','data/**','backups/**']},
 {files:['**/*.mjs'],languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:globals.node},rules},
 {files:['public/**/*.js'],languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:globals.browser},rules},
];
