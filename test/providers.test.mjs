import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeWithProviders,
  checkProviders,
  classifyWithJev,
  explainWithOpenAI,
  providerDefaults,
  resolveJevRoute,
} from '../src/providers.mjs';

const UNIT = {
  id: 'src/auth.mjs:updateSession',
  path: 'src/auth.mjs',
  status: 'modified',
  diff: '- revokeAll();\n+ keepTrustedSessions();',
  oldCode: 'function updateSession() { revokeAll(); }',
  newCode: 'function updateSession() { keepTrustedSessions(); }',
  context: {
    related: [{ path: 'test/auth.test.mjs', code: 'test("revokes", () => {})' }],
    graph: { callers: ['updateEmail'] },
    warnings: ['mobile caller has no matching test'],
    truncated: false,
  },
};

const EXPLANATION = {
  title: 'Session preservation changes',
  oldLogic: 'Every session was revoked.',
  newLogic: 'Trusted sessions remain active.',
  whatChanged: 'Revocation is now selective.',
  whyHumanReview: 'Authentication behavior and an untested caller are affected.',
  signals: ['Authentication behavior changed'],
};

function providerFetch({
  explanation = EXPLANATION,
  openAIStatus = 'completed',
  openAIContentType = 'output_text',
  jevPriority = 'P0',
  jevConfidence = 0.84,
  jevProbabilities = { P0: 0.8, P1: 0.15, P2: 0.05 },
} = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (url.includes('openai.com')) {
      const content = openAIContentType === 'refusal'
        ? { type: 'refusal', refusal: 'No' }
        : { type: 'output_text', text: JSON.stringify(explanation) };
      return response({
        status: openAIStatus,
        model: 'gpt-test',
        output: [{ type: 'message', content: [content] }],
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      });
    }
    return response({
      model: 'jev-test',
      answers: {
        review_priority: {
          type: 'choice',
          choice: jevPriority,
          confidence: jevConfidence,
          probabilities: jevProbabilities,
        },
        dominant_risk: {
          type: 'choice',
          choice: 'security',
          confidence: 0.9,
          probabilities: { security: 0.9, behavior: 0.1 },
        },
        human_review_needed: { type: 'noul', noul: 0.97 },
      },
      usage: { input_tokens: 200, output_tokens: 20 },
    });
  };
  return { fetchImpl, calls };
}

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return body; } };
}

const credentials = { TYPESAFE_API_KEY: 'ts-secret', OPENAI_API_KEY: 'oa-secret' };

// Runs fn with every Jev routing input scrubbed, so the ambient environment
// cannot steer route resolution.
async function withCleanJevEnv(fn) {
  const saved = {};
  for (const name of ['TYPESAFE_API_KEY', 'CLASSIFIER_API_KEY', 'JEV_API_URL']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('uses OpenAI for prose and Jev for the actual priority', async () => {
  const mock = providerFetch();
  const changes = await analyzeWithProviders([UNIT], {
    credentials,
    fetchImpl: mock.fetchImpl,
    policy: { priorities: { P0: 'Always inspect auth changes.' } },
  });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].id, UNIT.id);
  assert.equal(changes[0].priority, 'P0');
  assert.equal(changes[0].title, EXPLANATION.title);
  assert.equal(changes[0].confidence, 0.84);
  assert.equal(changes[0].providerMetadata.jev.dominantRisk, 'security');
  assert.ok(changes[0].signals.includes('Jev dominant risk: security'));

  const openAI = mock.calls.find((call) => call.url.includes('openai.com'));
  const jev = mock.calls.find((call) => call.url.includes('typesafe.ai'));
  assert.equal(openAI.url, 'https://api.openai.com/v1/responses');
  assert.equal(openAI.body.store, false);
  assert.equal(openAI.body.model, providerDefaults.openAIModel);
  assert.equal(openAI.body.text.format.type, 'json_schema');
  assert.equal(openAI.body.text.format.strict, true);
  assert.match(openAI.body.input[0].content, /revokeAll/);
  assert.equal(jev.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(jev.body.model, 'jev-latest');
  assert.match(JSON.stringify(jev.body.state), /keepTrustedSessions/);
  assert.equal(jev.body.questions.review_priority.criteria.P0, 'Always inspect auth changes.');
  assert.equal(openAI.init.headers.Authorization, 'Bearer oa-secret');
  assert.equal(jev.init.headers.Authorization, 'Bearer ts-secret');
  assert.ok(openAI.init.signal instanceof AbortSignal);
  assert.ok(jev.init.signal instanceof AbortSignal);
});

test('stored credentials override inherited environment credentials', async () => {
  const previousOpenAI = process.env.OPENAI_API_KEY;
  const previousTypeSafe = process.env.TYPESAFE_API_KEY;
  process.env.OPENAI_API_KEY = 'stale-env-openai';
  process.env.TYPESAFE_API_KEY = 'stale-env-typesafe';
  const mock = providerFetch();
  try {
    await analyzeWithProviders([UNIT], {
      fetchImpl: mock.fetchImpl,
      loadCredentialsImpl: async () => ({
        OPENAI_API_KEY: 'replacement-stored-openai',
        TYPESAFE_API_KEY: 'replacement-stored-typesafe',
      }),
    });
  } finally {
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
    if (previousTypeSafe === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousTypeSafe;
  }
  const openAI = mock.calls.find((call) => call.url.includes('openai.com'));
  const jev = mock.calls.find((call) => call.url.includes('typesafe.ai'));
  assert.equal(openAI.init.headers.Authorization, 'Bearer replacement-stored-openai');
  assert.equal(jev.init.headers.Authorization, 'Bearer replacement-stored-typesafe');
});

test('applies a configured low-confidence escalation without inventing a Jev fallback', async () => {
  const mock = providerFetch({ jevPriority: 'P2', jevConfidence: 0.2 });
  const [change] = await analyzeWithProviders([UNIT], {
    credentials,
    fetchImpl: mock.fetchImpl,
    policy: { minimumConfidence: 0.6, lowConfidencePriority: 'P0' },
  });
  assert.equal(change.priority, 'P0');
  assert.equal(change.confidence, 0.2);
});

test('caps raw repository packets and marks truncation', async () => {
  const mock = providerFetch();
  const huge = {
    ...UNIT,
    oldCode: 'old'.repeat(20_000),
    newCode: 'new'.repeat(20_000),
    diff: 'diff'.repeat(20_000),
  };
  await analyzeWithProviders([huge], { credentials, fetchImpl: mock.fetchImpl });
  const jev = mock.calls.find((call) => call.url.includes('typesafe.ai'));
  const serialized = JSON.stringify(jev.body.state);
  assert.ok(serialized.length <= providerDefaults.maxPacketChars);
  assert.doesNotThrow(() => JSON.parse(serialized));
  assert.equal(jev.body.state.packetTruncation.applied, true);
});

test('canonical uncertainPriority escalates close classes and preserves the actual Jev choice', async () => {
  const mock = providerFetch({ jevPriority: 'P2', jevProbabilities: { P0: 0.02, P1: 0.48, P2: 0.5 } });
  const classification = await classifyWithJev(UNIT, { credentials, fetchImpl: mock.fetchImpl, policy: { uncertainPriority: 'P0' } });
  assert.equal(classification.priority, 'P0');
  assert.equal(classification.modelPriority, 'P2');
});

test('exports an independent Jev-only classifier for honest partial demos', async () => {
  const mock = providerFetch({ jevPriority: 'P1', jevConfidence: 0.72 });
  const classification = await classifyWithJev(UNIT, {
    credentials: { TYPESAFE_API_KEY: credentials.TYPESAFE_API_KEY },
    fetchImpl: mock.fetchImpl,
    policy: { uncertainPriority: 'P0', uncertaintyMargin: 0.01 },
  });
  assert.equal(classification.id, UNIT.id);
  assert.equal(classification.priority, 'P1');
  assert.equal(classification.confidence, 0.72);
  assert.equal(mock.calls.length, 1);
  assert.match(mock.calls[0].url, /typesafe\.ai/);
});

test('exports an independent OpenAI-only explainer without calling Jev', async () => {
  const mock = providerFetch();
  const explanation = await explainWithOpenAI(UNIT, {
    credentials: { OPENAI_API_KEY: credentials.OPENAI_API_KEY },
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(explanation.id, UNIT.id);
  assert.equal(explanation.title, EXPLANATION.title);
  assert.equal(explanation.providerMetadata.openai.model, 'gpt-test');
  assert.equal(mock.calls.length, 1);
  assert.match(mock.calls[0].url, /openai\.com/);
});

test('rejects an OpenAI refusal', async () => {
  const mock = providerFetch({ openAIContentType: 'refusal' });
  await assert.rejects(
    analyzeWithProviders([UNIT], { credentials, fetchImpl: mock.fetchImpl }),
    /OpenAI declined to explain this change/,
  );
});

test('rejects malformed OpenAI structured output', async () => {
  const mock = providerFetch({ explanation: { title: 'Missing fields' } });
  await assert.rejects(
    analyzeWithProviders([UNIT], { credentials, fetchImpl: mock.fetchImpl }),
    /malformed explanation/,
  );
});

test('rejects malformed Jev output instead of pretending to classify', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('openai.com')) {
      return response({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(EXPLANATION) }] }],
      });
    }
    return response({ answers: { review_priority: { type: 'choice', choice: 'P0' } } });
  };
  await assert.rejects(
    analyzeWithProviders([UNIT], { credentials, fetchImpl }),
    /Jev returned a malformed priority decision/,
  );
});

test('provider HTTP errors are sanitized and do not expose response bodies or keys', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('openai.com')) {
      return response({ error: { type: 'insufficient_quota', code: 'credit_balance_exhausted', message: 'secret raw text' } }, { ok: false, status: 429 });
    }
    return response({});
  };
  await assert.rejects(
    analyzeWithProviders([UNIT], { credentials, fetchImpl }),
    (error) => {
      assert.equal(error.message, 'OpenAI request failed (HTTP 429); insufficient_quota/credit_balance_exhausted.');
      assert.doesNotMatch(error.message, /oa-secret|ts-secret|secret raw text/);
      return true;
    },
  );
});

test('validates unit ids before making provider calls', async () => {
  let called = false;
  await assert.rejects(
    analyzeWithProviders([{ ...UNIT, id: '' }], {
      credentials,
      fetchImpl: async () => { called = true; },
    }),
    /non-empty string id/,
  );
  assert.equal(called, false);
});

test('checkProviders sends one small request per provider and names the key source on quota errors', async () => {
  const mock = providerFetch();
  const healthy = await checkProviders({ credentials, fetchImpl: mock.fetchImpl });
  assert.deepEqual(healthy.openai, { ok: true });
  assert.deepEqual(healthy.jev, { ok: true, provider: 'typesafe' });
  assert.equal(mock.calls.length, 2);

  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'env-openai-secret';
  try {
    const exhausted = await checkProviders({
      loadCredentialsImpl: async () => ({ TYPESAFE_API_KEY: 'stored-ts-secret' }),
      fetchImpl: async (url, init) => url.includes('openai.com')
        ? response({ error: { type: 'insufficient_quota', code: 'credit_balance_exhausted' } }, { ok: false, status: 429 })
        : mock.fetchImpl(url, init),
    });
    assert.equal(exhausted.jev.ok, true, 'one failing provider does not hide the other result');
    assert.equal(exhausted.openai.ok, false);
    assert.equal(exhausted.openai.error, "OpenAI request failed (HTTP 429); insufficient_quota/credit_balance_exhausted. Key used: OPENAI_API_KEY from this shell's environment.");
    assert.deepEqual(exhausted.sources, { TYPESAFE_API_KEY: 'stored', OPENAI_API_KEY: 'environment' });
    assert.doesNotMatch(JSON.stringify(exhausted), /secret/);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('auth failures during analysis name the stored key source, never the key', async () => {
  const mock = providerFetch();
  await assert.rejects(
    analyzeWithProviders([UNIT], {
      loadCredentialsImpl: async () => ({ TYPESAFE_API_KEY: 'stored-ts-secret', OPENAI_API_KEY: 'stored-oa-secret' }),
      fetchImpl: async (url, init) => url.includes('typesafe.ai') ? response({}, { ok: false, status: 401 }) : mock.fetchImpl(url, init),
    }),
    { message: 'Jev request failed (HTTP 401). Key used: TYPESAFE_API_KEY from the credentials file (~/.config/jev-reviewer/credentials.json).' },
  );
});

test('a missing key names every place that was checked', async () => {
  const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY };
  delete process.env.OPENAI_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    await assert.rejects(
      analyzeWithProviders([UNIT], { fetchImpl: providerFetch().fetchImpl, loadCredentialsImpl: async () => ({ TYPESAFE_API_KEY: 'stored-ts' }) }),
      { message: "OPENAI_API_KEY is not configured: it is not in ~/.config/jev-reviewer/credentials.json or in this shell's environment. Run jev-reviewer setup in your own terminal." },
    );
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('reports progress after each analyzed unit', async () => {
  const events = [];
  await analyzeWithProviders([UNIT, { ...UNIT, id: 'src/auth.mjs:second' }], {
    credentials,
    fetchImpl: providerFetch().fetchImpl,
    onProgress: (event) => events.push(event),
  });
  assert.deepEqual(events.map(({ index, total, path, priority }) => ({ index, total, path, priority })), [
    { index: 1, total: 2, path: 'src/auth.mjs', priority: 'P0' },
    { index: 2, total: 2, path: 'src/auth.mjs', priority: 'P0' },
  ]);
  assert.ok(events.every((event) => Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0));
});

test('resolveJevRoute prefers an explicit endpoint, then a TypeSafe key, then free classifier.dev', async () => {
  await withCleanJevEnv(async () => {
    assert.deepEqual(resolveJevRoute({}, {}), {
      url: 'https://classifier.dev/v1/systemone',
      provider: 'classifier.dev',
      apiKey: undefined,
      keyName: undefined,
      keySource: undefined,
    });
    const keyed = resolveJevRoute({ credentials: { TYPESAFE_API_KEY: 'ts-secret' } }, {});
    assert.equal(keyed.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(keyed.provider, 'typesafe');
    assert.equal(keyed.apiKey, 'ts-secret');
    assert.equal(keyed.keyName, 'TYPESAFE_API_KEY');
    const explicit = resolveJevRoute(
      { credentials: { TYPESAFE_API_KEY: 'ts-secret' }, jevEndpoint: 'https://proxy.internal/v1/systemone' },
      {},
    );
    assert.equal(explicit.url, 'https://proxy.internal/v1/systemone');
    assert.equal(explicit.provider, 'custom');
    assert.equal(explicit.apiKey, 'ts-secret');
  });
});

test('uses free classifier.dev for Jev when no TypeSafe key is configured', async () => {
  await withCleanJevEnv(async () => {
    const mock = providerFetch();
    const changes = await analyzeWithProviders([UNIT], {
      credentials: { OPENAI_API_KEY: 'oa-secret' },
      fetchImpl: mock.fetchImpl,
      loadCredentialsImpl: async () => ({}),
    });
    const jev = mock.calls.find((call) => call.url.includes('classifier.dev'));
    assert.equal(jev.url, 'https://classifier.dev/v1/systemone');
    assert.equal(jev.init.headers.Authorization, undefined);
    assert.equal(jev.body.model, 'jev-latest');
    assert.match(JSON.stringify(jev.body.state), /keepTrustedSessions/);
    assert.equal(changes[0].priority, 'P0');
    assert.equal(changes[0].providerMetadata.jev.provider, 'classifier.dev');
    assert.equal(changes[0].providerMetadata.jev.viaFallback, false);
  });
});

test('JEV_API_URL overrides the Jev endpoint', async () => {
  await withCleanJevEnv(async () => {
    process.env.JEV_API_URL = 'https://proxy.internal/v1/systemone';
    const mock = providerFetch();
    const classification = await classifyWithJev(UNIT, {
      credentials: { TYPESAFE_API_KEY: 'ts-secret' },
      fetchImpl: mock.fetchImpl,
      loadCredentialsImpl: async () => ({}),
    });
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url, 'https://proxy.internal/v1/systemone');
    assert.equal(mock.calls[0].init.headers.Authorization, 'Bearer ts-secret');
    assert.equal(classification.providerMetadata.jev.provider, 'custom');
    assert.equal(classification.providerMetadata.jev.endpoint, 'https://proxy.internal/v1/systemone');
  });
});

test('falls back to keyed TypeSafe when free classifier.dev is rate-limited', async () => {
  await withCleanJevEnv(async () => {
    process.env.JEV_API_URL = 'https://classifier.dev/v1/systemone';
    const mock = providerFetch();
    const urls = [];
    const fetchImpl = async (url, init) => {
      urls.push(url);
      if (url.includes('classifier.dev')) {
        return response({ error: { code: 'rate_limited' } }, { ok: false, status: 429 });
      }
      return mock.fetchImpl(url, init);
    };
    const changes = await analyzeWithProviders([UNIT], {
      credentials: { OPENAI_API_KEY: 'oa-secret', TYPESAFE_API_KEY: 'ts-secret' },
      fetchImpl,
      loadCredentialsImpl: async () => ({}),
    });
    assert.deepEqual(
      urls.filter((url) => !url.includes('openai.com')),
      ['https://classifier.dev/v1/systemone', 'https://api.typesafe.ai/v1/systemone'],
    );
    const fallbackCall = mock.calls.find((call) => call.url.includes('typesafe.ai'));
    assert.equal(fallbackCall.init.headers.Authorization, 'Bearer ts-secret');
    assert.equal(changes[0].providerMetadata.jev.provider, 'typesafe');
    assert.equal(changes[0].providerMetadata.jev.viaFallback, true);
  });
});

test('a rate-limited free tier without a TypeSafe key explains the limit instead of blaming a key', async () => {
  await withCleanJevEnv(async () => {
    const mock = providerFetch();
    const fetchImpl = async (url, init) => url.includes('openai.com')
      ? mock.fetchImpl(url, init)
      : response({ error: { code: 'rate_limited' } }, { ok: false, status: 429 });
    await assert.rejects(
      analyzeWithProviders([UNIT], {
        credentials: { OPENAI_API_KEY: 'oa-secret' },
        fetchImpl,
        loadCredentialsImpl: async () => ({}),
      }),
      (error) => {
        assert.match(error.message, /Jev request failed \(HTTP 429\)/);
        assert.match(error.message, /free classifier\.dev tier is rate-limited/);
        assert.match(error.message, /TYPESAFE_API_KEY/);
        assert.doesNotMatch(error.message, /oa-secret/);
        return true;
      },
    );
  });
});

test('checkProviders reports which Jev route answered', async () => {
  await withCleanJevEnv(async () => {
    const mock = providerFetch();
    const keyless = await checkProviders({
      credentials: { OPENAI_API_KEY: 'oa-secret' },
      fetchImpl: mock.fetchImpl,
      loadCredentialsImpl: async () => ({}),
    });
    assert.deepEqual(keyless.jev, { ok: true, provider: 'classifier.dev' });
    const keyed = await checkProviders({
      credentials: { OPENAI_API_KEY: 'oa-secret', TYPESAFE_API_KEY: 'ts-secret' },
      fetchImpl: mock.fetchImpl,
      loadCredentialsImpl: async () => ({}),
    });
    assert.deepEqual(keyed.jev, { ok: true, provider: 'typesafe' });
  });
});
