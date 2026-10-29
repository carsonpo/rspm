// Runs the real CLI against the dev-style worker handler over HTTP.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle } from '../worker/src/handler.js';
import { Vault, putItem } from '../core/vault.js';
import { deriveKeys, generateAccountKey } from '../core/kdf.js';
import { testStore, testEnv, deps } from './helpers.js';
import { eq, ok } from '../tools/check.js';

const CLI = fileURLToPath(new URL('../cli/rspm.js', import.meta.url));

async function withServer(fn) {
  const env = testEnv();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://localhost');
    const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env, deps);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, env); } finally { server.close(); }
}

function run(args, envVars) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...envVars } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, out, err }));
  });
}

export async function cliEndToEnd() {
  await withServer(async (base, env) => {
    const { store } = testStore(env);
    const k = await generateAccountKey();
    const v = await Vault.create(store, await deriveKeys('cli-user', 'cli password 123', k.bytes));
    await v.update((d) => {
      putItem(d, { type: 'login', name: 'GitHub', username: 'me', password: 's3cret' });
      putItem(d, { type: 'env', name: 'api-prod', vars: { API_KEY: "it's secret", PORT: '8080' } });
      putItem(d, { type: 'totp', name: 'AWS', otpauth: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' });
    });
    const creds = { RSPM_USERNAME: 'cli-user', RSPM_PASSWORD: 'cli password 123', RSPM_ACCOUNT_KEY: k.display, RSPM_API: base, RSPM_BLOCKS: `${base}/v1` };

    const ls = await run(['ls'], creds);
    eq(ls.code, 0, ls.err);
    ok(ls.out.includes('GitHub') && ls.out.includes('api-prod'));

    eq((await run(['get', 'github'], creds)).out, 's3cret');
    eq((await run(['get', 'git', '--field', 'username'], creds)).out, 'me');
    ok(/^\d{6}\n$/.test((await run(['totp', 'aws'], creds)).out));
    eq((await run(['env', 'api-prod'], creds)).out, "export API_KEY='it'\\''s secret'\nexport PORT='8080'\n");

    const r = await run(['run', '--env', 'api-prod', '--', process.execPath, '-e', 'process.stdout.write(process.env.API_KEY + "|" + process.env.PORT); process.exit(3)'], creds);
    eq([r.out, r.code], ["it's secret|8080", 3], 'env injected and exit code propagated');

    const bad = await run(['ls'], { ...creds, RSPM_PASSWORD: 'wrong' });
    eq(bad.code, 1);
    ok(bad.err.includes('nothing matches'));
  });
}
