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
        options: {
          baseURL: 'https://api.bigmodel.example/v1',
          apiKey: 'PRIVATE_API_KEY',
          apiKeyRequired: true,
          headers: { 'X-Client': 'codex' },
        },
        models: {
          'GLM-5.2': {
            name: 'GLM 5.2',
            contextWindow: 131_072,
            maxOutputTokens: 16_384,
            reasoning: {
              enabled: true,
              levels: ['high'],
              defaultLevel: 'high',
              providerOptionsByLevel: { high: { reasoningEffort: 'high' } },
            },
            supportsImages: true,
            supportsPdf: true,
            supportsToolCall: true,
            supportsStructuredOutput: false,
            options: { modelFamily: 'glm' },
          },
          'glm-4.7': { name: 'GLM 4.7' },
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

/** @returns {any} */
function nativeMinimalConfig() {
  return {
    model: { main: 'custom/model-1' },
    provider: {
      custom: {
        kind: 'openai-compatible',
        models: { 'model-1': {} },
      },
    },
  };
}

/** @param {any} config */
async function nativeRuntime(config) {
  const home = await configFixture(JSON.stringify(config));
  return readZCodeCliRuntimeModel({ home, now: () => 7, revision: () => 'native-test' });
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

test('maps the minimal current CLI provider config without inventing passthrough fields', async () => {
  const runtime = await nativeRuntime(nativeMinimalConfig());
  assert.deepEqual(runtime, {
    revision: 'native-test',
    generatedAt: 7,
    model: { providerId: 'custom', modelId: 'model-1' },
    provider: {
      providerId: 'custom', kind: 'openai-compatible', source: 'user',
      models: [{ modelId: 'model-1' }],
    },
  });
});

test('synthesizes the selected runtime model when optional provider.models is absent', async () => {
  const config = nativeMinimalConfig();
  delete config.provider.custom.models;
  const runtime = await nativeRuntime(config);
  assert.deepEqual(runtime.provider.models, [{ modelId: 'model-1' }]);
});

test('selects a unique model alias by raw id when no exact key exists', async () => {
  const config = nativeMinimalConfig();
  config.model.main = 'custom/target';
  config.provider.custom.models = {
    alias: { id: 'target', options: { temperature: 0 } },
  };
  const runtime = await nativeRuntime(config);
  assert.deepEqual(runtime.provider.models, [{
    modelId: 'target', providerOptions: { openaiCompatible: { temperature: 0 } },
  }]);
});

test('rejects an exact model key that collides with an earlier alias id using the fixed error', async () => {
  const config = nativeMinimalConfig();
  config.model.main = 'custom/target';
  config.provider.custom.models = {
    alias: { id: 'target', options: { temperature: 1 } },
    target: { options: { temperature: 0 } },
  };
  assertFixedRuntimeConfigError(await nativeRuntime(config).catch((error) => error));
});

test('rejects multiple aliases that normalize to the same model id using the fixed error', async () => {
  const config = nativeMinimalConfig();
  config.model.main = 'custom/target';
  config.provider.custom.models = {
    first: { id: 'target' },
    second: { id: 'target' },
  };
  assertFixedRuntimeConfigError(await nativeRuntime(config).catch((error) => error));
});

test('accepts the native shorthand root model while the legacy main-model reader remains compatible', async () => {
  const config = nativeMinimalConfig();
  config.model = 'custom/model-1';
  const home = await configFixture(JSON.stringify(config));
  assert.deepEqual(await readZCodeCliMainModel({ home }), { providerId: 'custom', modelId: 'model-1' });
  assert.deepEqual((await readZCodeCliRuntimeModel({
    home, now: () => 7, revision: () => 'native-test',
  })).model, { providerId: 'custom', modelId: 'model-1' });
});

test('merges provider, provider option, and model headers in native met order', async () => {
  const config = nativeMinimalConfig();
  config.provider.custom.headers = { Shared: 'provider', Provider: 'yes' };
  config.provider.custom.options = { headers: { Shared: 'options', Options: 'yes' } };
  config.provider.custom.models['model-1'].headers = { Shared: 'model', Model: 'yes' };
  const runtime = await nativeRuntime(config);
  assert.deepEqual(runtime.provider.headers, {
    Shared: 'model', Provider: 'yes', Options: 'yes', Model: 'yes',
  });
});

test('wraps raw model options in the provider kind namespace', async (t) => {
  for (const [kind, namespace] of [
    ['anthropic', 'anthropic'], ['openai', 'openai'], ['openai-compatible', 'openaiCompatible'],
  ]) await t.test(kind, async () => {
    const config = nativeMinimalConfig();
    config.provider.custom.kind = kind;
    config.provider.custom.models['model-1'].options = { reasoningEffort: 'high' };
    const runtime = await nativeRuntime(config);
    assert.deepEqual(runtime.provider.models[0].providerOptions, {
      [namespace]: { reasoningEffort: 'high' },
    });
  });
});

test('maps native model capability fields and aliases', async () => {
  const config = nativeMinimalConfig();
  Object.assign(config.provider.custom.models['model-1'], {
    supportsToolCall: false,
    tool_call: true,
    modalities: { input: ['text', 'pdf'] },
    structured_output: true,
  });
  const model = (await nativeRuntime(config)).provider.models[0];
  assert.equal(model.supportsTools, false);
  assert.equal(model.supportsPdf, true);
  assert.equal(model.supportsStructuredOutput, true);
});

test('maps raw reasoning strings and selects a valid root thought level', async () => {
  const config = nativeMinimalConfig();
  config.provider.custom.models['model-1'].reasoning = {
    levels: ['low', 'high'],
    defaultLevel: 'missing',
    providerOptionsByLevel: { high: { reasoningEffort: 'high' } },
  };
  const runtime = await nativeRuntime(config);
  assert.deepEqual(runtime.provider.models[0].reasoning, {
    enabled: true,
    levels: [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }],
    defaultLevel: 'missing',
    providerOptionsByLevel: {
      high: { openaiCompatible: { reasoningEffort: 'high' } },
    },
  });
  assert.equal(runtime.thoughtLevel, 'low');
});

test('ignores passthrough fields that native model normalization does not consume', async () => {
  const config = nativeMinimalConfig();
  Object.assign(config.provider.custom, {
    apiFormat: 'openai-responses',
    providerOptions: { leaked: 'provider' },
    logoUrl: 'https://ignored.invalid/logo.svg',
    modelsDevProviderId: 'ignored-provider',
  });
  Object.assign(config.provider.custom.models['model-1'], {
    providerOptions: { leaked: 'model' },
    supportsTools: true,
    reasoning: { enabled: true, levels: [{ value: 'high', label: 'High' }] },
  });
  const runtime = await nativeRuntime(config);
  assert.equal(Object.hasOwn(runtime.provider, 'apiFormat'), false);
  assert.equal(Object.hasOwn(runtime.provider, 'providerOptions'), false);
  assert.equal(Object.hasOwn(runtime.provider, 'logoUrl'), false);
  assert.equal(Object.hasOwn(runtime.provider, 'modelsDevProviderId'), false);
  assert.deepEqual(runtime.provider.models[0], { modelId: 'model-1' });
  assert.equal(Object.hasOwn(runtime, 'thoughtLevel'), false);
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
      source: 'user',
      baseURL: 'https://api.bigmodel.example/v1',
      apiKey: { source: 'inline', value: 'PRIVATE_API_KEY' },
      apiKeyRequired: true,
      headers: { 'X-Client': 'codex' },
      models: [
        {
          modelId: 'GLM-5.2',
          label: 'GLM 5.2',
          contextWindow: 131_072,
          maxOutputTokens: 16_384,
          reasoning: {
            enabled: true,
            levels: [{ value: 'high', label: 'high' }],
            defaultLevel: 'high',
            providerOptionsByLevel: { high: { openaiCompatible: { reasoningEffort: 'high' } } },
          },
          supportsImages: true,
          supportsPdf: true,
          supportsTools: true,
          supportsStructuredOutput: false,
          providerOptions: { openaiCompatible: { modelFamily: 'glm' } },
        },
        { modelId: 'glm-4.7', label: 'GLM 4.7' },
      ],
    },
    thoughtLevel: 'high',
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

test('omits the optional provider label when provider.name is absent', async () => {
  const home = await completeConfigFixture((config) => {
    delete config.provider.bigmodel.name;
    return config;
  });
  const runtime = await readZCodeCliRuntimeModel({
    home, now: () => 1, revision: () => 'revision-1',
  });
  assert.equal(Object.hasOwn(runtime.provider, 'label'), false);
});

test('omits optional model labels when selected and unselected model names are absent', async () => {
  const home = await completeConfigFixture((config) => {
    delete config.provider.bigmodel.models['GLM-5.2'].name;
    delete config.provider.bigmodel.models['glm-4.7'].name;
    return config;
  });
  const runtime = await readZCodeCliRuntimeModel({
    home, now: () => 1, revision: () => 'revision-1',
  });
  assert.deepEqual(runtime.provider.models.map(({ modelId, label }) => ({ modelId, label })), [
    { modelId: 'GLM-5.2', label: undefined },
    { modelId: 'glm-4.7', label: undefined },
  ]);
  assert.equal(runtime.provider.models.every((model) => !Object.hasOwn(model, 'label')), true);
});

test('allows openai-compatible providers without an optional baseURL', async () => {
  const home = await completeConfigFixture((config) => {
    delete config.provider.bigmodel.options.baseURL;
    return config;
  });
  const runtime = await readZCodeCliRuntimeModel({
    home, now: () => 1, revision: () => 'revision-1',
  });
  assert.equal(Object.hasOwn(runtime.provider, 'baseURL'), false);
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
    config.provider.bigmodel.models['GLM-5.2'].options = {};
    config.provider.bigmodel.models['GLM-5.2'].reasoning.providerOptionsByLevel = {};
    return config;
  });
  const runtime = await readZCodeCliRuntimeModel({
    home, now: () => 1, revision: () => 'revision-1',
  });
  assert.equal(Object.hasOwn(runtime.provider, 'headers'), false);
  assert.equal(Object.hasOwn(runtime.provider, 'providerOptions'), false);
  assert.deepEqual(runtime.provider.models[0].providerOptions, { openaiCompatible: {} });
  assert.deepEqual(runtime.provider.models[0]?.reasoning?.providerOptionsByLevel, {});
});

test('preserves finite JSON numbers in supported provider options', async () => {
  const home = await completeConfigFixture((config) => {
    config.provider.bigmodel.models['GLM-5.2'].options = { temperature: 0.25 };
    return config;
  });
  const runtime = await readZCodeCliRuntimeModel({
    home, now: () => 1, revision: () => 'revision-1',
  });
  assert.deepEqual(runtime.provider.models[0].providerOptions, {
    openaiCompatible: { temperature: 0.25 },
  });
});

test('preserves bounded JSON arrays in supported provider options', async () => {
  const home = await completeConfigFixture((config) => {
    config.provider.bigmodel.models['GLM-5.2'].options = {
      stop: ['END'], nested: [{ enabled: true }],
    };
    return config;
  });
  const runtime = await readZCodeCliRuntimeModel({
    home, now: () => 1, revision: () => 'revision-1',
  });
  assert.deepEqual(runtime.provider.models[0].providerOptions, {
    openaiCompatible: { stop: ['END'], nested: [{ enabled: true }] },
  });
});

test('rejects invalid runtime shapes, values, selection, and collection bounds with one fixed error', async (t) => {
  /** @type {Array<[string,(config:any)=>void]>} */
  const invalidCases = [
    ['missing provider', (config) => { delete config.provider.bigmodel; }],
    ['unsupported kind', (config) => { config.provider.bigmodel.kind = 'private-kind'; }],
    ['invalid options array', (config) => { config.provider.bigmodel.options = []; }],
    ['invalid headers', (config) => { config.provider.bigmodel.options.headers = { Authorization: 3 }; }],
    ['invalid provider options nesting', (config) => {
      /** @type {any} */
      let value = {}; config.provider.bigmodel.models['GLM-5.2'].options = value;
      for (let index = 0; index < 20; index += 1) { value.next = {}; value = value.next; }
    }],
    ['oversized provider options array', (config) => {
      config.provider.bigmodel.models['GLM-5.2'].options = { stop: Array.from({ length: 257 }, () => 'END') };
    }],
    ['invalid model metadata', (config) => { config.provider.bigmodel.models['GLM-5.2'].supportsToolCall = 'yes'; }],
    ['invalid reasoning metadata', (config) => { config.provider.bigmodel.models['GLM-5.2'].reasoning.enabled = 'yes'; }],
    ['control string', (config) => { config.provider.bigmodel.name = 'Big\u0000Model'; }],
    ['C1 control string', (config) => { config.provider.bigmodel.name = 'Big\u0085Model'; }],
    ['oversized string', (config) => { config.provider.bigmodel.models['GLM-5.2'].name = 'x'.repeat(4097); }],
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
