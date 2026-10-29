#!/usr/bin/env node
// rspm command-line client. Runs on Node ≥ 20, Bun, or Deno (node: built-ins only).
//
//   rspm ls                              list items
//   rspm get <item> [--field password]   print a field (default: password)
//   rspm totp <item>                     print the current two-factor code
//   rspm env <item>                      print an environment item as `export` lines
//   rspm run --env <item> -- <cmd...>    run a command with the item's variables set
//
// Credentials come from RSPM_USERNAME, RSPM_PASSWORD and RSPM_ACCOUNT_KEY, or
// are prompted for on a terminal. Endpoints: RSPM_API, RSPM_BLOCKS.

import { spawn } from 'node:child_process';
import { Store, DEFAULT_ENDPOINTS } from '../core/store.js';
import { deriveKeys, parseAccountKey } from '../core/kdf.js';
import { Vault, VaultNotFoundError } from '../core/vault.js';
import { totp } from '../core/totp.js';

const USAGE = `usage:
  rspm ls
  rspm get <item> [--field <name>]
  rspm totp <item>
  rspm env <item>
  rspm run --env <item> -- <command> [args...]

Credentials: RSPM_USERNAME, RSPM_PASSWORD, RSPM_ACCOUNT_KEY (prompted if unset).`;

class CliError extends Error {}

function prompt(question, { hidden = false } = {}) {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) throw new CliError(`${question.trim()} — not a terminal; set the RSPM_* environment variables`);
  stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stderr.write('\n');
      err ? reject(err) : resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new CliError('cancelled'));
        if (ch === '\u007f' || ch === '\b') {
          if (value) { value = value.slice(0, -1); if (!hidden) stderr.write('\b \b'); }
          continue;
        }
        value += ch;
        if (!hidden) stderr.write(ch);
      }
    };
    stdin.on('data', onData);
  });
}

async function openVault() {
  const env = process.env;
  const username = env.RSPM_USERNAME ?? (await prompt('Username: '));
  const password = env.RSPM_PASSWORD ?? (await prompt('Password: ', { hidden: true }));
  const keyText = env.RSPM_ACCOUNT_KEY ?? (await prompt('Account Key: ', { hidden: true }));
  const accountKey = await parseAccountKey(keyText);
  const store = new Store({ api: env.RSPM_API ?? DEFAULT_ENDPOINTS.api, blocks: env.RSPM_BLOCKS ?? DEFAULT_ENDPOINTS.blocks });
  try {
    return await Vault.open(store, await deriveKeys(username, password, accountKey));
  } catch (e) {
    if (e instanceof VaultNotFoundError) throw new CliError('nothing matches that username, password and Account Key');
    throw e;
  }
}

function find(doc, query, type) {
  const pool = doc.items.filter((i) => !type || i.type === type || (type === 'totp' && i.otpauth));
  const q = query.toLowerCase();
  const exact = pool.filter((i) => i.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = pool.filter((i) => i.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (!partial.length) throw new CliError(`no ${type ? `${type} ` : ''}item matches "${query}"`);
  throw new CliError(`"${query}" matches several items: ${partial.map((i) => i.name).join(', ')}`);
}

const shellQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') { console.log(USAGE); return 0; }

  if (cmd === 'ls') {
    const v = await openVault();
    for (const i of [...v.doc.items].sort((a, b) => a.name.localeCompare(b.name))) console.log(`${i.type.padEnd(6)}  ${i.name}`);
    return 0;
  }

  if (cmd === 'get') {
    const fi = rest.indexOf('--field');
    const field = fi >= 0 ? rest[fi + 1] : 'password';
    const name = (fi >= 0 ? rest.filter((_, i) => i !== fi && i !== fi + 1) : rest).join(' ');
    if (!name || !field) throw new CliError(USAGE);
    const item = find((await openVault()).doc, name);
    const value = item.type === 'env' ? item.vars?.[field] : item[field];
    if (value == null) throw new CliError(`"${item.name}" has no field "${field}"`);
    process.stdout.write(String(value) + (process.stdout.isTTY ? '\n' : ''));
    return 0;
  }

  if (cmd === 'totp') {
    const item = find((await openVault()).doc, rest.join(' '), 'totp');
    const { code } = await totp(item.otpauth);
    console.log(code);
    return 0;
  }

  if (cmd === 'env') {
    const item = find((await openVault()).doc, rest.join(' '), 'env');
    for (const [k, v] of Object.entries(item.vars ?? {})) console.log(`export ${k}=${shellQuote(v)}`);
    return 0;
  }

  if (cmd === 'run') {
    const sep = rest.indexOf('--');
    const ei = rest.indexOf('--env');
    if (sep < 0 || ei < 0 || ei > sep || !rest[ei + 1]) throw new CliError(USAGE);
    const command = rest.slice(sep + 1);
    if (!command.length) throw new CliError(USAGE);
    const item = find((await openVault()).doc, rest[ei + 1], 'env');
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, ...item.vars } });
    return new Promise((resolve) => {
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
      child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      child.on('error', (e) => { console.error(`rspm: ${e.message}`); resolve(127); });
    });
  }

  throw new CliError(`unknown command "${cmd}"\n\n${USAGE}`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => { console.error(`rspm: ${e instanceof CliError ? e.message : e.stack ?? e}`); process.exit(1); },
);
