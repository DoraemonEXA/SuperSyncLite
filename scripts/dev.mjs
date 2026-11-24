import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

const args = process.argv.slice(2);
const { values } = parseArgs({
  args,
  strict: false,
  allowPositionals: true,
  options: {
    remote: { type: 'boolean', short: 'r' },
    tunnel: { type: 'boolean' },
    'tunnel-name': { type: 'string' },
  },
});

// Only a local simulator with local bindings gets the username-only admin build.
const enabled = (value) => value !== undefined && value !== false && value !== 'false';
if (!enabled(values.remote) && !enabled(values.tunnel) && !values['tunnel-name']) {
  args.push(
    '--local',
    '--remote=false',
    '--tunnel=false',
    '--define',
    'import.meta.localAdminLogin:true',
  );
}
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', ...args], {
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
