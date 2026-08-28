import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { readZCodeCliMainModel, readZCodeCliRuntimeModel } from '../scripts/lib/zcode-runtime-config.mjs';

/** @param {string} contents */
async function configFixture(contents) {
  const home = await mkdtemp(join(tmpdir(), 'zcode-runtime-config-'));
  const directory = join(home, '.zcode', 'cli');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'config.json'), contents);
  return home;
}

/** @returns {any} */
function completeConfig() {
  return {
    model: { main: 'bigmodel/GLM-5.2' },
    provider: {
      bigmodel: {
        kind: 'openai-compatible',
        name: 'BigModel',
        source: 'custom',
        options: {
          apiFormat: 'openai-chat-completions',
          baseURL: 'https://api.bigmodel.example/v1',
          apiKey: 'PRIVATE_API_KEY',
          apiKeyRequired: true,
          headers: { 'X-Client': 'codex' },
          providerOptions: { compatibility: { mode: 'strict' } },
          logoUrl: 'https://assets.example/bigmodel.svg',
          modelsDevProviderId: 'bigmodel-provider',
        },
        models: {
          'GLM-5.2': {
            name: 'GLM 5.2',
            description: 'Primary model',
            contextWindow: 131_072,
            maxOutputTokens: 16_384,
            reasoning: {
              enabled: true,
              levels: [{ value: 'high', label: 'High', description: 'More reasoning' }],
              defaultLevel: 'high',
              providerOptionsByLevel: { high: { reasoningEffort: 'high' } },
            },
            supportsImages: true,
            supportsPdf: true,
            supportsTools: true,
            supportsStructuredOutput: false,
            providerOptions: { modelFamily: 'glm' },
          },
          'glm-4.7': { name: 'GLM 4.7', disabledReason: 'Legacy' },
        },
        ignoredSecret: 'PRIVATE_PROVIDER_SECRET',
      },
    },
    providerOptions: { apiKey: 'PRIVATE_UNRELATED_SECRET' },
  };
}

/** @param {(value:any)=>any} [update] */
async function completeConfigFixture(update = (value) => value) {
  return configFixture(JSON.stringify(update(completeConfig())));
}

/** @param {unknown} error */
function assertFixedRuntimeConfigError(error) {
  assert.ok(error instanceof PluginError);
  assert.equal(error.code, 'ZCODE_RUNTIME_MODEL_CONFIG_INVALID');
  assert.equal(error.message, 'ZCode runtime model configuration is unavailable.');
  assert.equal(error.cause, undefined);
  assert.deepEqual(error.details, {});
  assert.doesNotMatch(JSON.stringify(error), /config\.json|\.zcode|PRIVATE|token|secret|endpoint|apiKey|providerOptions/i);
}

test('reads model.main from HOME and splits at only the first slash', async () => {
  const home = await configFixture(JSON.stringify({
    model: { main: 'provider/model/variant' },
    providerOptions: { endpoint: 'https://private.invalid', apiKey: 'PRIVATE_API_KEY' },
  }));

  assert.deepEqual(await readZCodeCliMainModel({ env: { HOME: home } }), {
    providerId: 'provider', modelId: 'model/variant',
  });
});

test('falls back from absent HOME to USERPROFILE', async () => {
  const home = await configFixture(JSON.stringify({ model: { main: 'fallback/model' } }));
  assert.deepEqual(await readZCodeCliMainModel({ env: { USERPROFILE: home } }), {
    providerId: 'fallback', modelId: 'model',
  });
});

test('falls back from empty HOME to USERPROFILE', async () => {
  const home = await configFixture(JSON.stringify({ model: { main: 'profile/model' } }));
  assert.deepEqual(await readZCodeCliMainModel({ env: { HOME: '', USERPROFILE: home } }), {
    providerId: 'profile', modelId: 'model',
  });
});

test('normalizes the selected complete runtime model with an in-memory inline credential', async () => {
  const home = await completeConfigFixture();
  const runtime = await readZCodeCliRuntimeModel({
    home,
    now: () => 1_788_000_000_000,
    revision: () => 'codex-runtime-test',
  });

  assert.deepEqual(runtime, {
    revision: 'codex-runtime-test',
    generatedAt: 1_788_000_000_000,
    model: { providerId: 'bigmodel', modelId: 'GLM-5.2' },
    provider: {
      providerId: 'bigmodel',
      kind: 'openai-compatible',
      label: 'BigModel',
      source: 'custom',
      apiFormat: 'openai-chat-completions',
      baseURL: 'https://api.bigmodel.example/v1',
      apiKey: { source: 'inline', value: 'PRIVATE_API_KEY' },
      apiKeyRequired: true,
      headers: { 'X-Client': 'codex' },
      providerOptions: { compatibility: { mode: 'strict' } },
      logoUrl: 'https://assets.example/bigmodel.svg',
      modelsDevProviderId: 'bigmodel-provider',
      models: [
        {
          modelId: 'GLM-5.2',
          label: 'GLM 5.2',
          description: 'Primary model',
          contextWindow: 131_072,
          maxOutputTokens: 16_384,
          reasoning: {
            enabled: true,
            levels: [{ value: 'high', label: 'High', description: 'More reasoning' }],
            defaultLevel: 'high',
            providerOptionsByLevel: { high: { reasoningEffort: 'high' } },
          },
          supportsImages: true,
          supportsPdf: true,
          supportsTools: true,
          supportsStructuredOutput: false,
          providerOptions: { modelFamily: 'glm' },
        },
        { modelId: 'glm-4.7', label: 'GLM 4.7', disabledReason: 'Legacy' },
      ],
    },
  });
  assert.doesNotMatch(JSON.stringify(runtime), /PRIVATE_UNRELATED_SECRET|PRIVATE_PROVIDER_SECRET/);
});

test('uses an explicit exact tuple and preserves a model id containing slashes', async () => {
  const home = await completeConfigFixture((config) => {
    config.provider.other = {
      kind: 'anthropic', name: 'Other', options: { apiFormat: 'anthropic-messages' },
      models: { 'family/model/variant': { name: 'Variant' } },
    };
    return config;
  });
  const runtime = await readZCodeCliRuntimeModel({
    env: { HOME: home },
    model: { providerId: 'other', modelId: 'family/model/variant' },
    now: () => 0,
    revision: () => 'revision-1',
  });
  assert.deepEqual(runtime.model, { providerId: 'other', modelId: 'family/model/variant' });
  assert.equal(runtime.provider.providerId, 'other');
  assert.equal(runtime.provider.source, 'user');
  assert.deepEqual(runtime.provider.models, [{ modelId: 'family/model/variant', label: 'Variant' }]);
});

test('runtime resolver falls back from HOME to USERPROFILE', async () => {
  const home = await completeConfigFixture();
  const runtime = await readZCodeCliRuntimeModel({
    env: { HOME: '', USERPROFILE: home }, now: () => 1, revision: () => 'revision-1',
  });
  assert.deepEqual(runtime.model, { providerId: 'bigmodel', modelId: 'GLM-5.2' });
});

test('accepts empty supported option records', async () => {
  const home = await completeConfigFixture((config) => {
    config.provider.bigmodel.options.headers = {};
    config.provider.bigmodel.options.providerOptions = {};
    config.provider.bigmodel.models['GLM-5.2'].providerOptions = {};
    config.provider.bigmodel.models['GLM-5.2'].reasoning.providerOptionsByLevel = {};
    return config;
  });
  const runtime = await readZCodeCliRuntimeModel({
    home, now: () => 1, revision: () => 'revision-1',
  });
  assert.deepEqual(runtime.provider.headers, {});
  assert.deepEqual(runtime.provider.providerOptions, {});
  assert.deepEqual(runtime.provider.models[0].providerOptions, {});
  assert.deepEqual(runtime.provider.models[0]?.reasoning?.providerOptionsByLevel, {});
});

test('preserves finite JSON numbers in supported provider options', async () => {
  const home = await completeConfigFixture((config) => {
    config.provider.bigmodel.options.providerOptions = { temperature: 0.25 };
    return config;
  });
  const runtime = await readZCodeCliRuntimeModel({
    home, now: () => 1, revision: () => 'revision-1',
  });
  assert.deepEqual(runtime.provider.providerOptions, { temperature: 0.25 });
});

test('rejects invalid runtime shapes, values, selection, and collection bounds with one fixed error', async (t) => {
  /** @type {Array<[string,(config:any)=>void]>} */
  const invalidCases = [
    ['missing provider', (config) => { delete config.provider.bigmodel; }],
    ['missing selected model', (config) => { delete config.provider.bigmodel.models['GLM-5.2']; }],
    ['unsupported kind', (config) => { config.provider.bigmodel.kind = 'private-kind'; }],
    ['invalid source', (config) => { config.provider.bigmodel.source = 'remote'; }],
    ['invalid api format', (config) => { config.provider.bigmodel.options.apiFormat = 'private-format'; }],
    ['missing required base url', (config) => { delete config.provider.bigmodel.options.baseURL; }],
    ['missing required api key', (config) => { delete config.provider.bigmodel.options.apiKey; }],
    ['invalid options array', (config) => { config.provider.bigmodel.options = []; }],
    ['invalid headers', (config) => { config.provider.bigmodel.options.headers = { Authorization: 3 }; }],
    ['invalid provider options nesting', (config) => {
      /** @type {any} */
      let value = {}; config.provider.bigmodel.options.providerOptions = value;
      for (let index = 0; index < 20; index += 1) { value.next = {}; value = value.next; }
    }],
    ['invalid model metadata', (config) => { config.provider.bigmodel.models['GLM-5.2'].supportsTools = 'yes'; }],
    ['invalid reasoning metadata', (config) => { config.provider.bigmodel.models['GLM-5.2'].reasoning.levels = [{}]; }],
    ['control string', (config) => { config.provider.bigmodel.name = 'Big\u0000Model'; }],
    ['C1 control string', (config) => { config.provider.bigmodel.name = 'Big\u0085Model'; }],
    ['oversized string', (config) => { config.provider.bigmodel.models['GLM-5.2'].description = 'x'.repeat(4097); }],
    ['provider array', (config) => { config.provider = []; }],
    ['models array', (config) => { config.provider.bigmodel.models = []; }],
    ['too many providers', (config) => {
      for (let index = 0; index < 65; index += 1) config.provider[`extra-${index}`] = config.provider.bigmodel;
    }],
    ['too many models', (config) => {
      for (let index = 0; index < 257; index += 1) config.provider.bigmodel.models[`extra-${index}`] = { name: `Extra ${index}` };
    }],
  ];

  for (const [name, mutate] of invalidCases) await t.test(name, async () => {
    const home = await completeConfigFixture((config) => { mutate(config); return config; });
    const error = await readZCodeCliRuntimeModel({
      home, now: () => 1, revision: () => 'revision-1', maxBytes: 256 * 1024,
    }).catch((caught) => caught);
    assertFixedRuntimeConfigError(error);
  });
});

test('rejects invalid explicit tuple, generated time, and revision without exposing values', async (t) => {
  const home = await completeConfigFixture();
  /** @type {Array<[string,Record<string,any>]>} */
  const cases = [
    ['tuple array', { model: /** @type {any} */ ([]) }],
    ['missing explicit provider', { model: { providerId: 'missing', modelId: 'PRIVATE_MODEL' } }],
    ['invalid time', { now: () => -1 }],
    ['unsafe time', { now: () => Number.MAX_SAFE_INTEGER + 1 }],
    ['invalid revision', { revision: () => 'PRIVATE\nREVISION' }],
  ];
  for (const [name, input] of cases) await t.test(name, async () => {
    const error = await readZCodeCliRuntimeModel({
      home, now: () => 1, revision: () => 'revision-1', ...input,
    }).catch((caught) => caught);
    assertFixedRuntimeConfigError(error);
  });
});

test('maps missing, unreadable, oversized, malformed, symlinked, and non-regular runtime config to the fixed error', async (t) => {
  /** @type {Array<[string,()=>Promise<string>]>} */
  const cases = [
    ['missing', async () => mkdtemp(join(tmpdir(), 'zcode-runtime-config-missing-'))],
    ['oversized', async () => completeConfigFixture()],
    ['malformed', async () => configFixture('{"apiKey":"PRIVATE_TOKEN",')],
    ['symlink', async () => {
      const home = await mkdtemp(join(tmpdir(), 'zcode-runtime-config-link-'));
      const directory = join(home, '.zcode', 'cli'); await mkdir(directory, { recursive: true });
      const target = join(home, 'private.json'); await writeFile(target, JSON.stringify(completeConfig()));
      await symlink(target, join(directory, 'config.json')); return home;
    }],
    ['non-regular', async () => {
      const home = await mkdtemp(join(tmpdir(), 'zcode-runtime-config-directory-'));
      await mkdir(join(home, '.zcode', 'cli', 'config.json'), { recursive: true }); return home;
    }],
  ];
  if (process.platform !== 'win32') cases.splice(1, 0, ['unreadable', async () => {
    const home = await completeConfigFixture();
    await chmod(join(home, '.zcode', 'cli', 'config.json'), 0o000); return home;
  }]);

  for (const [name, createHome] of cases) await t.test(name, async () => {
    const home = await createHome();
    const error = await readZCodeCliRuntimeModel({
      home, maxBytes: name === 'oversized' ? 32 : 64 * 1024,
    }).catch((caught) => caught);
    assertFixedRuntimeConfigError(error);
  });
});

test('maps missing, unreadable, oversized, malformed, symlinked, and invalid config to one fixed secret-free error', async (t) => {
  const secret = 'PRIVATE_TOKEN_VALUE';
  /** @type {Array<[string,()=>Promise<string>]>} */
  const cases = [
    ['missing', async () => mkdtemp(join(tmpdir(), 'zcode-runtime-config-missing-'))],
    ['oversized', async () => configFixture(JSON.stringify({ model: { main: `provider/${'x'.repeat(256)}` }, token: secret }))],
    ['malformed', async () => configFixture(`{"token":"${secret}",`) ],
    ['invalid main', async () => configFixture(JSON.stringify({ model: { main: 'missing-slash' }, apiKey: secret }))],
    ['empty provider', async () => configFixture(JSON.stringify({ model: { main: '/model' }, endpoint: secret }))],
    ['empty model', async () => configFixture(JSON.stringify({ model: { main: 'provider/' }, secret }))],
    ['symlink', async () => {
      const home = await mkdtemp(join(tmpdir(), 'zcode-runtime-config-link-'));
      const directory = join(home, '.zcode', 'cli'); await mkdir(directory, { recursive: true });
      const target = join(home, 'private.json'); await writeFile(target, JSON.stringify({ model: { main: 'provider/model' }, token: secret }));
      await symlink(target, join(directory, 'config.json')); return home;
    }],
  ];
  if (process.platform !== 'win32') cases.splice(1, 0, ['unreadable', async () => {
    const home = await configFixture(JSON.stringify({ model: { main: 'provider/model' } }));
    await chmod(join(home, '.zcode', 'cli', 'config.json'), 0o000); return home;
  }]);

  for (const [name, createHome] of cases) await t.test(name, async () => {
    const home = await createHome();
    const error = await readZCodeCliMainModel({ env: { HOME: home }, maxBytes: name === 'oversized' ? 32 : 64 * 1024 }).catch((caught) => caught);
    assert.ok(error instanceof PluginError);
    assert.equal(error.code, 'ZCODE_RUNTIME_MODEL_CONFIG_INVALID');
    assert.equal(error.message, 'ZCode runtime model configuration is unavailable.');
    assert.equal(error.cause, undefined);
    assert.deepEqual(error.details, {});
    assert.doesNotMatch(JSON.stringify(error), /config\.json|\.zcode|PRIVATE|token|secret|endpoint|apiKey|providerOptions/i);
  });
});
