import { build } from 'esbuild';
await build({ entryPoints: ['app/renderer/backtest/searchEngine.ts'], outfile: 'app/search-dist/engine.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: false });
await build({ entryPoints: ['app/renderer/automation/engine.ts'], outfile: 'app/search-dist/automation.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: false });
