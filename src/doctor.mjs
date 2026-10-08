import { command } from './git.mjs';
import { loadCredentials, keySources, describeKeySource } from '../scripts/setup-keys.mjs';

// Reports where things are, never key or token values. Safe to run from a coding agent.
export async function runDoctor({ live = true, port = 4731, log = console.log } = {}) {
  let ok = true;
  const mark = { ok: '✓', warn: '!', fail: '✗', info: '–' };
  const line = (status, text) => {
    if (status === 'fail') ok = false;
    log(`${mark[status]} ${text}`);
  };

  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 22 ? 'ok' : 'fail', major >= 22 ? `Node ${process.versions.node}` : `Node ${process.versions.node}: Jev-Reviewer needs Node 22 or newer.`);
  try { await command('git', ['--version']); line('ok', 'git is installed'); }
  catch { line('fail', 'git is not installed or not on PATH.'); }
  try { line('ok', `GitHub CLI is signed in as ${(await command('gh', ['api', 'user', '--jq', '.login'])).trim()}`); }
  catch { line('fail', 'GitHub CLI (gh) is missing or not signed in. Run gh auth login.'); }
  try { await command('sh', ['-c', 'command -v graphify']); line('ok', 'Graphify is installed'); }
  catch { line('info', 'Graphify is not installed (optional; analysis works with less context).'); }

  let stored = {};
  try { stored = await loadCredentials(); }
  catch (error) { line('fail', error.message); }
  const sources = keySources(stored);
  for (const entry of sources) {
    if (entry.name === 'TYPESAFE_API_KEY' && !entry.used) {
      line('info', 'TYPESAFE_API_KEY: not set — Jev classification will use free classifier.dev (no key needed). Set it for the keyed TypeSafe route.');
      continue;
    }
    const status = entry.used === 'stored' ? 'ok' : entry.used === 'environment' ? 'warn' : 'fail';
    line(status, `${entry.name}: ${describeKeySource(entry)}.${status === 'ok' ? '' : ' Run jev-reviewer setup in your own terminal.'}`);
  }

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    if (body?.app === 'jev-reviewer') line('ok', `Local server is running on 127.0.0.1:${port}`);
    else line('warn', `Something other than Jev-Reviewer is answering on port ${port}.`);
  } catch {
    line('info', `Local server is not running on 127.0.0.1:${port}. Start it with jev-reviewer serve before opening the PR.`);
  }
  line('info', 'Extension pairing is checked in Chrome: its Connection → Save button confirms the token.');

  if (!live) line('info', 'Provider check skipped (--offline).');
  else if (sources.some((entry) => entry.name !== 'TYPESAFE_API_KEY' && !entry.used)) line('info', 'Provider check skipped because the OpenAI key is missing.');
  else {
    log('Checking provider access (one small request to each provider)…');
    try {
      const { checkProviders } = await import('./providers.mjs');
      const result = await checkProviders();
      line(result.jev.ok ? 'ok' : 'fail', result.jev.ok ? `Jev accepted the request via ${result.jev.provider}` : result.jev.error);
      line(result.openai.ok ? 'ok' : 'fail', result.openai.ok ? 'OpenAI accepted the key and has quota' : result.openai.error);
    } catch (error) {
      line('fail', error.message);
    }
  }
  log(ok ? 'Ready to analyze.' : 'Fix the ✗ items, then run jev-reviewer doctor again.');
  return ok;
}
