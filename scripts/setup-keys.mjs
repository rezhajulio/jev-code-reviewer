#!/usr/bin/env node
// Run this in your own terminal. Key values are never printed or sent to the agent.
import { mkdir, readFile, writeFile, rename, chmod, lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const credentialsPath = join(homedir(), '.config', 'jev-reviewer', 'credentials.json');
const KEY_LABELS = Object.freeze({ TYPESAFE_API_KEY: 'Jev / TypeSafe API key (optional)', OPENAI_API_KEY: 'OpenAI API key' });

// Where each key is, never what it is. Stored keys win over the environment
// (see resolveCredentials in src/providers.mjs).
export function keySources(stored = {}, env = process.env) {
  return Object.keys(KEY_LABELS).map((name) => {
    const storedValue = typeof stored?.[name] === 'string' ? stored[name].trim() : '';
    const envValue = typeof env?.[name] === 'string' ? env[name].trim() : '';
    return {
      name,
      stored: Boolean(storedValue),
      environment: Boolean(envValue),
      differ: Boolean(storedValue && envValue && storedValue !== envValue),
      used: storedValue ? 'stored' : envValue ? 'environment' : null,
    };
  });
}

export function describeKeySource(entry) {
  if (entry.used === 'stored') {
    if (entry.differ) return 'stored in the credentials file and used. This shell also exports a different value, which is ignored';
    return entry.environment ? 'stored in the credentials file (this shell exports the same value)' : 'stored in the credentials file';
  }
  if (entry.used === 'environment') return "only in this shell's environment, not stored. Other shells and coding agents will not see it";
  return "missing: not in the credentials file or this shell's environment";
}

async function confirm(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    prompt.close();
  }
}

export async function loadCredentials(path = credentialsPath) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    // Do not include parser messages: they can contain parts of a key.
    throw new Error('Could not read the local credentials file. Check its JSON format locally.');
  }
}

export async function saveCredentials(values, path = credentialsPath) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Credentials directory must not be a symlink.');
  await chmod(directory, 0o700);
  const temporary = join(directory, `.credentials-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(values, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

export function readSecret(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run setup in an interactive terminal; do not paste keys into chat or command arguments.');
  }
  return new Promise((accept, reject) => {
    let value = '';
    const previousRaw = process.stdin.isRaw;
    process.stdout.write(label);
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (error) => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else accept(value.trim());
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003' || character === '\u0004') return finish(new Error('Setup cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ' && character !== '\u001b') value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

export async function setupKeys({ replaceOpenAI = process.argv.includes('--replace-openai'), env = process.env } = {}) {
  const existing = await loadCredentials();
  const updated = { ...existing };
  let changed = false;
  console.log('Jev-Reviewer key setup. Input is hidden. Keys are stored outside the repository.');
  console.log('The TypeSafe key is optional: without it, Jev classification uses free classifier.dev (no key needed).');
  for (const entry of keySources(existing, env)) {
    const label = KEY_LABELS[entry.name];
    if (!(replaceOpenAI && entry.name === 'OPENAI_API_KEY')) {
      if (entry.stored) {
        console.log(`${label}: ${describeKeySource(entry)} (value hidden).`);
        continue;
      }
      if (entry.name === 'TYPESAFE_API_KEY' && !entry.environment) {
        console.log(`${label}: ${describeKeySource(entry)}.`);
        if (await confirm('Use free classifier.dev for Jev classification instead of a TypeSafe key? [Y/n] ')) {
          console.log(`${label}: skipped — Jev will use free classifier.dev (no key needed).`);
          continue;
        }
      } else if (entry.environment) {
        // An exported key only works in shells that load it; agent shells often do not.
        console.log(`${label}: ${describeKeySource(entry)}.`);
        if (await confirm(`Store this shell's value in ${credentialsPath}? [Y/n] `)) {
          updated[entry.name] = env[entry.name].trim();
          changed = true;
          console.log(`${label}: stored.`);
        } else {
          console.log(`${label}: left in the environment only.`);
        }
        continue;
      }
    }
    const value = await readSecret(`${label} (paste, then Enter): `);
    if (!value) throw new Error(`${label} was empty. Run setup again when ready.`);
    updated[entry.name] = value;
    changed = true;
  }
  if (changed) await saveCredentials(updated);
  if (changed) console.log(`Saved to ${credentialsPath} (owner-only file permissions; not encrypted).`);
  const unstored = keySources(updated, env)
    .filter((entry) => !entry.stored && entry.name !== 'TYPESAFE_API_KEY')
    .map((entry) => entry.name);
  if (unstored.length) console.log(`Warning: ${unstored.join(' and ')} ${unstored.length > 1 ? 'are' : 'is'} not stored, so analyze fails in shells without ${unstored.length > 1 ? 'them' : 'it'}.`);
  else if (keySources(updated, env).some((entry) => entry.name === 'TYPESAFE_API_KEY' && entry.stored)) console.log('Both keys are stored.');
  else console.log('OpenAI key stored. Jev will use free classifier.dev (no TypeSafe key stored).');
  console.log('API access has not been tested yet. Run jev-reviewer doctor to test it (one small request to each provider).');
  console.log('You can now tell the agent: keys are ready. Do not send the key values.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  setupKeys().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
