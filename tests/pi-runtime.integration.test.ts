import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAssistantMessageEventStream, registerApiProvider } from '@earendil-works/pi-ai/compat';
import { createAgentSessionFromServices, initTheme, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { ModelRegistry } from '@earendil-works/pi-coding-agent/dist/core/model-registry.js';
import { findInitialModel } from '@earendil-works/pi-coding-agent/dist/core/model-resolver.js';
import { createEventBus } from '@earendil-works/pi-coding-agent/dist/core/event-bus.js';
import { createExtensionRuntime, loadExtensionFromFactory } from '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import routerExtension, { __testResetInternalState, __testSetPiConfigDir } from '../index.js';

const tempDirs: string[] = [];

afterEach(() => {
  __testSetPiConfigDir(null);
  __testResetInternalState();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createConfigDir(modelsJson: unknown = { providers: {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-runtime-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'pi-router.json'), JSON.stringify({
    auto: false,
    autoSync: false,
    healthProbe: { enabled: false },
    models: [{ id: 'm1', channels: ['dynamic-provider'] }],
  }));
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(modelsJson));
  __testSetPiConfigDir(dir);
  return dir;
}

async function loadRouterFactory(eventBus = createEventBus()) {
  const extensionRuntime = createExtensionRuntime();
  const loaded = await loadExtensionFromFactory(
    routerExtension,
    process.cwd(),
    eventBus,
    extensionRuntime,
    '<inline:pi-router-test>',
  );
  expect(loaded).toBeDefined();
  return { extension: loaded, runtime: extensionRuntime };
}

function applyPendingProviders(runtime: ModelRuntime, loaded: Awaited<ReturnType<typeof loadRouterFactory>>) {
  for (const registration of loaded.runtime.pendingProviderRegistrations) {
    runtime.registerProvider(registration.name, registration.config);
  }
  loaded.runtime.pendingProviderRegistrations = [];
}

describe('Pi 0.84 ModelRuntime integration', () => {
  it('selects router/auto before session_start when the upstream provider catalog is runtime-only', async () => {
    createConfigDir();
    const eventBus = createEventBus();
    const loaded = await loadRouterFactory(eventBus);
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });

    runtime.registerProvider('dynamic-provider', {
      api: 'openai-completions',
      baseUrl: 'https://dynamic.test',
      apiKey: 'dynamic-key',
      models: [{
        id: 'm1', name: 'Dynamic M1', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000, maxTokens: 16384,
      }],
    });
    applyPendingProviders(runtime, loaded);
    await runtime.refresh({ allowNetwork: false });

    const selected = await findInitialModel({
      scopedModels: [],
      isContinuing: false,
      defaultProvider: 'router',
      defaultModelId: 'auto',
      modelRuntime: runtime,
    });

    expect(runtime.getModel('router', 'm1')).toEqual(expect.objectContaining({ provider: 'router', id: 'm1' }));
    expect(runtime.getModel('router', 'auto')).toEqual(expect.objectContaining({ provider: 'router', id: 'auto' }));
    expect(selected.model).toEqual(expect.objectContaining({ provider: 'router', id: 'auto' }));
  });

  it('keeps Session B request auth, routed dispatch, and adapter alive after Session A shuts down', async () => {
    initTheme('dark');
    const upstreamApi = 'pi-router-runtime-session-test-api';
    registerApiProvider({
      api: upstreamApi,
      stream: (() => createAssistantMessageEventStream()) as any,
      streamSimple: (model: any, _context: any, options: any) => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = {
            role: 'assistant', content: [{ type: 'text', text: options.apiKey }],
            api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop', timestamp: Date.now(),
          };
          stream.push({ type: 'done', reason: 'stop', message } as any);
          stream.end();
        });
        return stream;
      },
    } as any, 'pi-router-runtime-session-test');
    createConfigDir({
      providers: {
        'dynamic-provider': {
          api: upstreamApi, baseUrl: 'https://dynamic.test',
          models: [{
            id: 'm1', name: 'M1', reasoning: false, input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000, maxTokens: 4096,
          }],
        },
      },
    });
    const makeServices = async (key: string) => {
      const eventBus = createEventBus();
      const loaded = await loadRouterFactory(eventBus);
      const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      runtime.registerProvider('dynamic-provider', {
        api: upstreamApi, baseUrl: 'https://dynamic.test', apiKey: key,
        models: [{
          id: 'm1', name: 'M1', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000, maxTokens: 4096,
        }],
      });
      applyPendingProviders(runtime, loaded);
      const settingsManager = SettingsManager.inMemory();
      return {
        runtime,
        services: {
          cwd: process.cwd(), agentDir: testConfigDir,
          modelRuntime: runtime, settingsManager,
          resourceLoader: {
            getExtensions: () => ({ extensions: [loaded.extension], errors: [], runtime: loaded.runtime }),
            getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
            getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
            getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined,
            getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
          },
          diagnostics: [],
        } as any,
      };
    };
    const testConfigDir = createConfigDir();
    const first = await makeServices('session-a-key');
    const second = await makeServices('session-b-key');
    const firstSession = await createAgentSessionFromServices({
      services: first.services, sessionManager: SessionManager.inMemory(), model: first.runtime.getModel('router', 'm1'),
    });
    const secondSession = await createAgentSessionFromServices({
      services: second.services, sessionManager: SessionManager.inMemory(), model: second.runtime.getModel('router', 'm1'),
    });
    await firstSession.session.bindExtensions({});
    await secondSession.session.bindExtensions({});
    const registry = (globalThis as any)[Symbol.for('pi.routing.registry.v1')];
    const secondAdapter = registry.getRouter('router');

    await firstSession.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'reload' });

    expect(registry.getRouter('router')).toBe(secondAdapter);
    const secondRegistry = new ModelRegistry(second.runtime);
    expect((await secondRegistry.getApiKeyAndHeaders(second.runtime.getModel('dynamic-provider', 'm1')!)).apiKey).toBe('session-b-key');
    expect(second.runtime.getRegisteredProviderConfig('router')?.streamSimple).toBeTypeOf('function');
    const events: any[] = [];
    for await (const event of second.runtime.streamSimple(
      second.runtime.getModel('router', 'm1')!,
      { messages: [] },
      {},
    )) events.push(event);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.at(-1)?.message?.content?.[0]?.text).toBe('session-b-key');
    expect(registry.getRouter('router')).toBe(secondAdapter);
    await secondSession.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'reload' });
  });

  it('does not queue a late discovery registration that would replace an active catalog', async () => {
    createConfigDir({
      providers: {
        'dynamic-provider': {
          api: 'openai-completions', baseUrl: 'https://dynamic.test',
          models: [{
            id: 'm1', name: 'M1', reasoning: false, input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000, maxTokens: 4096,
          }],
        },
      },
    });
    const eventBus = createEventBus();
    const first = await loadRouterFactory(eventBus);
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    applyPendingProviders(runtime, first);

    runtime.registerProvider('router', {
      api: 'pi-router',
      baseUrl: 'https://router.internal',
      apiKey: 'router',
      models: [{
        id: 'dynamic-only', name: 'Dynamic only', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000, maxTokens: 4096,
      }],
      streamSimple: (() => { throw new Error('active-stream'); }) as any,
    });
    const before = runtime.getRegisteredProviderConfig('router');

    const duplicate = await loadRouterFactory(eventBus);
    expect(duplicate.runtime.pendingProviderRegistrations).toEqual([]);
    expect(runtime.getRegisteredProviderConfig('router')).toBe(before);
    expect(runtime.getModels('router').map(model => model.id)).toEqual(['dynamic-only']);
  });
});
