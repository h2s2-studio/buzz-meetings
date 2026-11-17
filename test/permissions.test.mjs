import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cameraPermissions } from '../src/permissions.ts';

test('camera settings use only the fixed OS privacy destinations declared for review', () => {
  const { host } = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  for (const [platform, program, url] of [
    ['MacIntel', 'open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera'],
    ['Win32', 'explorer.exe', 'ms-settings:privacy-webcam'],
  ]) {
    const help = cameraPermissions(platform);
    const command = host.commands.find(command => command.id === help.command);
    assert.equal(command.program, program);
    assert.deepEqual(command.args, [url]);
    assert.equal(command.maxInputBytes, undefined);
  }
  const linux = cameraPermissions('Linux x86_64');
  assert.equal(linux.command, undefined);
  assert.match(linux.instructions, /privacy or application settings/);
  assert.equal(cameraPermissions('').command, undefined);
});
