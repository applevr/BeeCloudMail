import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeLocalConfig } from './lib/local-config.mjs';

writeLocalConfig();
const wrangler = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)
);
const child = spawn(
  process.execPath,
  [wrangler, 'dev', '-c', 'wrangler.local.jsonc', '--port', '8788', '--local'],
  { windowsHide: true, stdio: 'inherit' }
);
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
child.on('exit', (code) => process.exit(code || 0));
