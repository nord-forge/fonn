// Opens the operating system's own folder chooser. A web page can never learn
// the full path of a folder the user picks, so the local server shows the
// dialog instead and returns the chosen path. Nothing is read from the folder.
import { execFile } from 'node:child_process';
import path from 'node:path';

export type FolderPicker = () => Promise<string | null>;

interface Command { file: string; args: string[] }

const PROMPT = 'Choose a project folder for Fonn';

/** The picker command for this platform, or undefined when none is available. */
export async function pickerCommand(platform = process.platform, which: (name: string) => Promise<boolean> = onPath): Promise<Command | undefined> {
  // `activate` brings the dialog in front of the browser.
  if (platform === 'darwin') return { file: 'osascript', args: ['-e', 'activate', '-e', `return POSIX path of (choose folder with prompt "${PROMPT}")`] };
  if (platform === 'linux') {
    if (await which('zenity')) return { file: 'zenity', args: ['--file-selection', '--directory', `--title=${PROMPT}`] };
    if (await which('kdialog')) return { file: 'kdialog', args: ['--getexistingdirectory', process.env.HOME ?? '/', '--title', PROMPT] };
  }
  return undefined;
}

function onPath(name: string): Promise<boolean> {
  return new Promise((resolve) => execFile('/bin/sh', ['-c', 'command -v "$1"', 'sh', name], (error) => resolve(!error)));
}

/** Shows the dialog. Resolves to the absolute path, or null when cancelled. */
export function systemFolderPicker(command: Command): FolderPicker {
  return () => new Promise((resolve, reject) => {
    // Ten minutes is plenty to pick a folder; the dialog closes after that.
    execFile(command.file, command.args, { timeout: 10 * 60 * 1000, encoding: 'utf8' }, (error, stdout) => {
      // Every picker exits non-zero when the user cancels.
      if (error) return error.killed ? reject(new Error('The folder picker timed out.')) : resolve(null);
      const chosen = stdout.trim().replace(/\/+$/, '') || '/';
      resolve(path.isAbsolute(chosen) ? chosen : null);
    });
  });
}
