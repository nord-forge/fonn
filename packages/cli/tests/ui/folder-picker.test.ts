import assert from 'node:assert/strict';
import test from 'node:test';
import { pickerCommand } from '../../src/ui/folder-picker.js';

test('the folder picker uses the system dialog: osascript on macOS, zenity or kdialog on Linux', async () => {
  const mac = await pickerCommand('darwin', async () => false);
  assert.equal(mac?.file, 'osascript');
  assert.match(mac!.args.join(' '), /choose folder/);
  assert.equal((await pickerCommand('linux', async (name) => name === 'zenity'))?.file, 'zenity');
  assert.equal((await pickerCommand('linux', async (name) => name === 'kdialog'))?.file, 'kdialog');
  assert.equal(await pickerCommand('linux', async () => false), undefined);
  assert.equal(await pickerCommand('win32', async () => true), undefined);
});
