import assert from 'node:assert/strict';
import test from 'node:test';

import { addonCompatibility, safeAddonFileName } from '../services/addon-service.js';

test('safeAddonFileName accepts one normal JAR filename and rejects path traversal', () => {
  assert.equal(safeAddonFileName('Example Plugin 1.2.3.jar'), 'Example Plugin 1.2.3.jar');
  assert.throws(() => safeAddonFileName('../outside.jar'), { code: 'invalid_addon_filename' });
  assert.throws(() => safeAddonFileName('nested/plugin.jar'), { code: 'invalid_addon_filename' });
  assert.throws(() => safeAddonFileName('not-a-jar.zip'), { code: 'invalid_addon_filename' });
});

test('plugin and mod compatibility remains separated by server software', () => {
  const paperPlugin = addonCompatibility(
    'plugin',
    { software: 'paper', version: '1.21.4' },
    { software: 'paper', apiVersion: '1.21', loader: undefined },
  );
  assert.equal(paperPlugin.compatible, true);

  const vanillaPlugin = addonCompatibility(
    'plugin',
    { software: 'vanilla', version: '1.21.4' },
    { software: 'paper', apiVersion: '1.21', loader: undefined },
  );
  assert.equal(vanillaPlugin.compatible, false);
  assert.match(vanillaPlugin.message ?? '', /Paper server/i);

  const paperMod = addonCompatibility(
    'mod',
    { software: 'paper', version: '1.21.4' },
    { software: 'fabric', apiVersion: undefined, loader: 'fabric' },
  );
  assert.equal(paperMod.compatible, false);

  const fabricMod = addonCompatibility(
    'mod',
    { software: 'fabric', version: '1.21.4' },
    { software: 'fabric', apiVersion: undefined, loader: 'fabric' },
  );
  assert.equal(fabricMod.compatible, true);
});
