import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import { createEventBus } from '@earendil-works/pi-coding-agent/dist/core/event-bus.js';
import { createExtensionRuntime, loadExtensionFromFactory } from '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import routerExtension, { __testResetInternalState, __testSetPiConfigDir } from '../index.js';

let configDir: string;
let autocomplete: CombinedAutocompleteProvider;

beforeEach(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-completions-'));
  fs.writeFileSync(path.join(configDir, 'pi-router.json'), JSON.stringify({
    auto: false,
    autoSync: false,
    healthProbe: { enabled: false },
    models: [{ id: 'test-model', channels: ['test-provider'] }],
  }));
  fs.writeFileSync(path.join(configDir, 'models.json'), JSON.stringify({ providers: {} }));
  __testSetPiConfigDir(configDir);

  const extension = await loadExtensionFromFactory(
    routerExtension,
    process.cwd(),
    createEventBus(),
    createExtensionRuntime(),
    '<inline:pi-router-completions-test>',
  );
  const command = extension.commands.get('router');
  expect(command?.getArgumentCompletions).toBeTypeOf('function');
  autocomplete = new CombinedAutocompleteProvider([{
    name: 'router',
    getArgumentCompletions: command!.getArgumentCompletions,
  }], configDir);
});

afterEach(() => {
  __testSetPiConfigDir(null);
  __testResetInternalState();
  if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
});

describe('/router argument completion', () => {
  it.each([
    ['conf', 'config', 'config'],
    ['config ', 'show (s)', 'config show'],
    ['config sh', 'show (s)', 'config show'],
    ['config show', 'show (s)', 'config show'],
    ['config w', 'wizard (w)', 'config wizard'],
    ['config o', 'order (o)', 'config order'],
    ['config r', 'reset (r)', 'config reset'],
    ['c sh', 'show (s)', 'c show'],
    ['reset a', 'all', 'reset all'],
    ['reset a', 'auto', 'reset auto'],
    ['reset test', 'test-model', 'reset test-model'],
  ])('completes "%s" to "%s" without dropping parent arguments', async (input, label, expected) => {
    const line = `/router ${input}`;
    const suggestions = await autocomplete.getSuggestions([line], 0, line.length, {});
    expect(suggestions).not.toBeNull();
    const item = suggestions!.items.find(item => item.label === label);
    expect(item).toBeDefined();
    const result = autocomplete.applyCompletion([line], 0, line.length, item!, suggestions!.prefix);
    expect(result.lines).toEqual([`/router ${expected}`]);
    expect(result.cursorCol).toBe(`/router ${expected}`.length);
  });

  it('preserves text after the cursor while replacing the whole argument prefix', async () => {
    const prefix = '/router config sh';
    const line = `${prefix} trailing text`;
    const suggestions = await autocomplete.getSuggestions([line], 0, prefix.length, {});
    const item = suggestions!.items.find(item => item.label === 'show (s)');
    const result = autocomplete.applyCompletion([line], 0, prefix.length, item!, suggestions!.prefix);
    expect(result.lines).toEqual(['/router config show trailing text']);
    expect(result.cursorCol).toBe('/router config show'.length);
  });

  it('does not offer unrelated config subcommands', async () => {
    const line = '/router config xyz';
    expect(await autocomplete.getSuggestions([line], 0, line.length, {})).toBeNull();
  });
});
