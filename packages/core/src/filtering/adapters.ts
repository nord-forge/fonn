export interface Reduction {
  adapter: string;
  text: string;
  removedLines: number;
}

type Adapter = 'phpunit' | 'pest' | 'tsc' | 'phpstan';

// Accept a single direct invocation. Shell pipelines, compound commands, quoted
// arguments, and wrappers have ambiguous provenance and are deliberately ignored.
function adapterFor(input: unknown): Adapter | undefined {
  if (!input || typeof input !== 'object' || !('command' in input) || typeof input.command !== 'string') return;
  const command = input.command.trim();
  if (/[\n\r;&|<>`$'"\\]/.test(command)) return;
  const tokens = command.split(/\s+/);
  if (tokens[0] === 'php') tokens.shift();
  if (tokens[0] === 'npx' || tokens[0] === 'pnpm' || tokens[0] === 'yarn') tokens.shift();
  const executable = tokens.shift();
  if (!executable) return;
  if (/^(?:\.\/)?(?:vendor\/bin\/)?phpunit$/.test(executable)) return 'phpunit';
  if (/^(?:\.\/)?(?:vendor\/bin\/)?pest$/.test(executable)) return 'pest';
  if (/^(?:\.\/)?(?:node_modules\/\.bin\/)?tsc$/.test(executable)) return 'tsc';
  if (/^(?:\.\/)?(?:vendor\/bin\/)?phpstan$/.test(executable) && /^(?:analyse|analyze)$/.test(tokens[0] ?? '')) return 'phpstan';
  if (executable === 'artisan' && tokens[0] === 'test') return 'pest';
}

function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function plain(line: string): string {
  return line.replace(/\r?\n$/, '');
}

function removeProgress(text: string, adapter: Adapter): Reduction {
  let removedLines = 0;
  const result = linesOf(text).filter((line) => {
    const content = plain(line);
    const recognized = adapter === 'phpstan'
      ? /^\s*\d+\/\d+ \[[= >▓░]+\]\s+\d{1,3}%\s*$/.test(content)
      : /^\s*\.{3,}\s+\d+\s*\/\s*\d+\s+\(\s*\d{1,3}%\)\s*$/.test(content);
    if (recognized) removedLines++;
    return !recognized;
  }).join('');
  return { adapter, text: result, removedLines };
}

function collapseTsc(text: string): Reduction {
  const lines = linesOf(text);
  // Non-pretty tsc diagnostics have an unambiguous boundary. Only immediately
  // adjacent byte-identical diagnostics are coalesced; multiplicity is retained.
  const diagnostic = /^(?:[^\r\n]+\(\d+,\d+\): error TS\d+:|error TS\d+:)/;
  let removedLines = 0;
  let result = '';
  for (let index = 0; index < lines.length;) {
    if (!diagnostic.test(plain(lines[index]))) {
      result += lines[index++];
      continue;
    }
    let end = index + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end]) && !diagnostic.test(plain(lines[end]))) end++;
    const blockLines = lines.slice(index, end);
    const block = blockLines.join('');
    let repeats = 1;
    let next = end;
    while (next + blockLines.length <= lines.length && lines.slice(next, next + blockLines.length).join('') === block) {
      repeats++;
      next += blockLines.length;
    }
    result += block;
    if (repeats > 1) {
      result += `${block.endsWith('\n') ? '' : '\n'}[fonn: identical diagnostic occurred ${repeats} times; ${repeats - 1} duplicate copies archived]\n`;
      removedLines += (repeats - 1) * blockLines.length;
    }
    index = next;
  }
  return { adapter: 'tsc', text: result, removedLines };
}

export function reduceRecognizedOutput(input: unknown, text: string): Reduction | undefined {
  const adapter = adapterFor(input);
  if (!adapter) return;
  // ANSI-rich and carriage-return output has cursor semantics we cannot safely
  // reconstruct. Preserve it, including progress written over previous lines.
  if (/\u001b|\r(?!\n)/.test(text)) return;
  if (adapter === 'tsc') return collapseTsc(text);
  if (adapter === 'phpstan') {
    if (!/^\s*\[(?:OK|ERROR)\]/m.test(text)) return;
  } else if (adapter === 'phpunit') {
    if (!/^PHPUnit \d+\.\d+/m.test(text) || !/^(?:OK \(|FAILURES!|ERRORS!|Tests:|OK, but there were issues!)/m.test(text)) return;
  } else if (!/^\s*(?:Tests:|PASS\s|FAIL\s)/m.test(text)) return;
  return removeProgress(text, adapter);
}
