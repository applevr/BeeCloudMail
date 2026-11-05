// Bundles all three Workers without publishing. Falls back to the examples when you have no
// configuration of your own, as in CI.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const wrangler = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)
);
for (const surface of ['webmail', 'admin', 'inbound']) {
  const own = `wrangler.${surface}.jsonc`;
  const config = existsSync(new URL(`../${own}`, import.meta.url))
    ? own
    : `wrangler.${surface}.example.jsonc`;
  const result = spawnSync(
    process.execPath,
    [wrangler, 'deploy', '--dry-run', '--config', config, '--outdir', `dist/${surface}`],
    { stdio: 'inherit', windowsHide: true }
  );
  if (result.status !== 0) process.exit(result.status || 1);
}
