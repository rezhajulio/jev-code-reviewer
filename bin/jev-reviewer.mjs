#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { setupKeys } from '../scripts/setup-keys.mjs';
import { ROOT, readJson, loadPolicy, applyPolicy, writeJson, reportPath, digest, pairingToken } from '../src/config.mjs';
import { resolvePr, buildUnits } from '../src/git.mjs';
import { enrichContext } from '../src/context.mjs';
import { coverageCounts, coveragePlan, savedLine, formatDuration } from '../src/summary.mjs';
import { startServer } from '../src/server.mjs';

const usage = `Jev-Reviewer — behavior-first PR review

  jev-reviewer setup                     Enter or store keys locally (Jev works keyless via free
                                         classifier.dev; OpenAI key required)
  jev-reviewer doctor [--offline]        Check tools, key sources, local server, and provider access
  jev-reviewer analyze --pr URL          Analyze committed PR code with both providers
    --repo PATH                         Local clone (default: current directory)
    --policy FILE                       JSON priority rules (default: repo .jev-reviewer.json)
    --graphify / --no-graphify           Static context graph (default: on)
    --max-units N                       Change units (diff hunks) to analyze, 1–100 (default: 12);
                                        the rest keep GitHub's original diff
    --jev-endpoint URL                  Jev API endpoint (default: free classifier.dev, or TypeSafe
                                        when TYPESAFE_API_KEY is set)
    --output FILE                       Also write a report file (contains source excerpts)
  jev-reviewer serve [--port 4731]       Start the local extension bridge
  jev-reviewer demo [--port 4731]        Open the bundled recorded-demo URL
  jev-reviewer token                    Print the extension pairing token (not model keys)

Node 22+, git and gh are required. Graphify is optional but recommended.
Live analysis sends committed code context to the Jev provider (classifier.dev's
free tier by default, TypeSafe when TYPESAFE_API_KEY is set) and to OpenAI.
The extension works on GitHub's classic Files changed page (/files), not yet the new /changes page.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    pr: { type: 'string' }, repo: { type: 'string' }, policy: { type: 'string' }, port: { type: 'string' },
    output: { type: 'string' }, 'max-units': { type: 'string' }, 'jev-endpoint': { type: 'string' }, graphify: { type: 'boolean' }, 'no-graphify': { type: 'boolean' }, offline: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const action = positionals[0];
  if (!action || values.help) return console.log(usage);
  if (action === 'setup') return setupKeys();
  if (action === 'doctor') {
    const { runDoctor } = await import('../src/doctor.mjs');
    if (!(await runDoctor({ live: !values.offline, port: Number(values.port || 4731) }))) process.exitCode = 1;
    return;
  }
  if (action === 'token') return console.log(await pairingToken());
  if (action === 'serve' || action === 'demo') {
    const port = Number(values.port || 4731);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
    const server = await startServer({ port });
    console.log(`Jev-Reviewer is ready at http://127.0.0.1:${port}/demo`);
    console.log('Extension bridge is running. Pair using: jev-reviewer token');
    if (action === 'demo') {
      const report = await readJson(join(ROOT, 'demo/report.json'));
      console.log(`GitHub demo: ${report.url}/files`);
      console.log(`Recorded analysis. Explanations: ${report.providers?.explanations || 'See report provenance'}.`);
    }
    console.log('Ctrl+C to stop.');
    process.on('SIGINT', () => server.close(() => process.exit(0)));
    return;
  }
  if (action !== 'analyze') throw new Error(`Unknown command: ${action}`);
  const started = Date.now();
  const repo = resolve(values.repo || '.');
  const maxUnits = Number(values['max-units'] || 12);
  if (!Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > 100) throw new Error('--max-units must be 1–100.');
  const metadata = await resolvePr(repo, values.pr);
  const { repo: _, ...identity } = metadata;
  const policy = await loadPolicy(repo, values.policy && resolve(values.policy));
  const units = await buildUnits(repo, metadata.baseSha, metadata.headSha);
  const selected = units.slice(0, maxUnits);
  console.log(`Reviewing ${metadata.repository} #${metadata.pullRequest} at ${metadata.headSha.slice(0, 8)}: ${units.length} change units (diff hunks).`);
  console.log(coveragePlan(units.length, selected.length, maxUnits));
  const { analyzeWithProviders, checkProviders } = await import('../src/providers.mjs');
  const providerOptions = { policy, jevEndpoint: values['jev-endpoint'] };
  let jevProvider = 'typesafe';
  if (selected.length) {
    // Fail in seconds on a bad key or exhausted quota, not after minutes of Graphify.
    console.log('Checking Jev and OpenAI access (one small request each)…');
    const check = await checkProviders(providerOptions);
    const failures = [check.jev, check.openai].filter((result) => !result.ok).map((result) => result.error);
    if (failures.length) throw new Error(`Provider check failed; nothing was analyzed. ${failures.join(' ')}`);
    jevProvider = check.jev.provider;
    console.log(`Providers OK (Jev via ${jevProvider}).`);
  }
  const contextStarted = Date.now();
  const context = await enrichContext(repo, metadata.headSha, units, { useGraphify: !values['no-graphify'], progress: console.log });
  console.log(`Graphify: ${context.graphify} (${formatDuration(Date.now() - contextStarted)}).`);
  if (selected.length) console.log(`Running Jev classification and OpenAI explanations on ${selected.length} ${selected.length === 1 ? 'unit' : 'units'}, one at a time…`);
  const onProgress = ({ index, total, path, priority, elapsedMs }) => console.log(`  [${index}/${total}] ${priority} ${path} (${formatDuration(elapsedMs)})`);
  const generated = selected.length ? await analyzeWithProviders(selected, { ...providerOptions, onProgress }) : [];
  const byId = new Map(generated.map(change => [change.id, change]));
  if (generated.length !== selected.length || selected.some(unit => !byId.has(unit.id))) throw new Error('Provider results did not cover every requested unit. Existing report was not overwritten.');
  const changes = units.map(unit => {
    const result = byId.get(unit.id) || { id: unit.id, title: `Not analyzed: ${unit.path}`, priority: 'P0', oldLogic: 'Not analyzed.', newLogic: 'Not analyzed.', whatChanged: 'This change exceeded the configured analysis limit.', whyHumanReview: 'Inspect the original diff or rerun with a larger --max-units value.', signals: ['not_analyzed'], confidence: null };
    return {
      ...applyPolicy(result, unit, policy), files: [unit.path], diff: unit.diff,
      evidence: [
        { path: unit.oldPath, startLine: unit.oldRange.startLine, endLine: unit.oldRange.endLine, side: 'old', snippet: unit.oldCode },
        { path: unit.path, startLine: unit.newRange.startLine, endLine: unit.newRange.endLine, side: 'new', snippet: unit.newCode },
      ],
      contextWarnings: unit.context.warnings, graph: unit.context.graph,
    };
  });
  const jevLabel = jevProvider === 'classifier.dev' ? 'classifier.dev (free Jev)'
    : jevProvider === 'typesafe' ? 'TypeSafe Jev'
    : `Jev (${jevProvider})`;
  const jevProvenance = jevProvider === 'classifier.dev' ? 'live-classifier-dev-api'
    : jevProvider === 'typesafe' ? 'live-typesafe-api'
    : 'live-custom-jev-api';
  const report = { schemaVersion: 1, ...identity, generatedAt: new Date().toISOString(), mode: 'live',
    providers: { classifier: jevLabel, explanations: 'OpenAI' }, policyHash: digest(policy), display: policy.display,
    provenance: { classification: jevProvenance, explanations: 'live-openai-api', note: 'Generated from the committed revisions recorded in this report. Priority suggests human attention, not correctness.' },
    context, coverage: { total: units.length, analyzed: selected.length, unanalysed: units.length - selected.length }, changes,
  };
  const path = reportPath(metadata.repository, metadata.pullRequest);
  await writeJson(path, report);
  if (values.output) await writeJson(resolve(values.output), report);
  console.log(savedLine(coverageCounts(changes)));
  console.log(`Report: ${path}`);
  console.log(`Open ${metadata.url}/files with jev-reviewer serve running and the extension paired. GitHub's new Files changed page (/changes) is not supported yet.`);
  console.log(`Done in ${formatDuration(Date.now() - started)}.`);
}
main().catch(error => { console.error(`Jev-Reviewer: ${error.message}`); process.exitCode = 1; });
