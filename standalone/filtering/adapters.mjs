// Generated from packages/core/dist/filtering/adapters.js by scripts/build-standalone-filter.mjs; do not edit.
// Accept a single direct invocation. Shell pipelines, compound commands, quoted
// arguments, and wrappers have ambiguous provenance and are deliberately ignored.
function adapterFor(input) {
    if (!input || typeof input !== 'object' || !('command' in input) || typeof input.command !== 'string')
        return;
    const command = input.command.trim();
    if (/[\n\r;&|<>`$'"\\]/.test(command))
        return;
    const tokens = command.split(/\s+/);
    if (tokens[0] === 'python' || tokens[0] === 'python3')
        return tokens[1] === '-m' && tokens[2] === 'pytest' ? 'pytest' : undefined;
    if (['npm', 'pnpm', 'yarn'].includes(tokens[0]) && (tokens[1] === 'test' || (tokens[1] === 'run' && tokens[2] === 'test')))
        return 'js-test';
    if (tokens[0] === 'php')
        tokens.shift();
    if (tokens[0] === 'npx' || tokens[0] === 'pnpm' || tokens[0] === 'yarn')
        tokens.shift();
    const executable = tokens.shift();
    if (!executable)
        return;
    if (/^(?:\.\/)?(?:vendor\/bin\/)?phpunit$/.test(executable))
        return 'phpunit';
    if (/^(?:\.\/)?(?:vendor\/bin\/)?pest$/.test(executable))
        return 'pest';
    if (/^(?:\.\/)?(?:node_modules\/\.bin\/)?tsc$/.test(executable))
        return 'tsc';
    if (/^(?:\.\/)?(?:vendor\/bin\/)?phpstan$/.test(executable) && /^(?:analyse|analyze)$/.test(tokens[0] ?? ''))
        return 'phpstan';
    if (executable === 'artisan' && tokens[0] === 'test')
        return 'pest';
    if (/^(?:\.\/)?(?:\.?venv\/bin\/)?(?:pytest|py\.test)$/.test(executable))
        return 'pytest';
    if (/^(?:\.\/)?(?:node_modules\/\.bin\/)?jest$/.test(executable))
        return 'jest';
    if (/^(?:\.\/)?(?:node_modules\/\.bin\/)?vitest$/.test(executable))
        return 'vitest';
}
// Lines each adapter may drop. Every pattern matches a certain pass or pure
// progress; anything carrying F, E, s, x, FAILED, SKIPPED, ✕ or × stays.
const removable = {
    pytest: [
        /^(?:\S+\.py )?\.+\s+\[\s*\d{1,3}%\]\s*$/,
        /^\S+\.py::\S.* PASSED\s+\[\s*\d{1,3}%\]\s*$/,
    ],
    jest: [/^PASS\s+\S+(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/, /^\s*[✓√] \S.*$/],
    vitest: [/^\s*[✓√] \S.*$/],
};
// A runner's own closing summary must be present before anything is removed.
const summaries = {
    pytest: [/^=+ test session starts =+\s*$/m, /^=+ .*\b(?:passed|failed|errors?|skipped|deselected|xfailed|xpassed|no tests ran)\b.* in \d+(?:\.\d+)?s\b.*=+\s*$/m],
    jest: [/^Test Suites: .*\btotal\s*$/m, /^Tests: .*\btotal\s*$/m],
    vitest: [/^\s*Test Files\s+.*\(\d+\)\s*$/m, /^\s*Tests\s+.*\(\d+\)\s*$/m],
};
function removeLines(text, adapter) {
    const patterns = removable[adapter];
    if (!patterns || !summaries[adapter].every((summary) => summary.test(text)))
        return;
    let removedLines = 0;
    const result = linesOf(text).filter((line) => {
        const drop = patterns.some((pattern) => pattern.test(plain(line)));
        if (drop)
            removedLines++;
        return !drop;
    }).join('');
    return { adapter, text: result, removedLines };
}
function linesOf(text) {
    return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
function plain(line) {
    return line.replace(/\r?\n$/, '');
}
function removeProgress(text, adapter) {
    let removedLines = 0;
    const result = linesOf(text).filter((line) => {
        const content = plain(line);
        const recognized = adapter === 'phpstan'
            ? /^\s*\d+\/\d+ \[[= >▓░]+\]\s+\d{1,3}%\s*$/.test(content)
            : /^\s*\.{3,}\s+\d+\s*\/\s*\d+\s+\(\s*\d{1,3}%\)\s*$/.test(content);
        if (recognized)
            removedLines++;
        return !recognized;
    }).join('');
    return { adapter, text: result, removedLines };
}
function collapseTsc(text) {
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
        while (end < lines.length && /^\s+\S/.test(lines[end]) && !diagnostic.test(plain(lines[end])))
            end++;
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
export const repeatedLineNote = '[fonn: identical line occurred ';
export const similarLinesNote = '[fonn: similar lines omitted; ';
// Masks the parts of a log line that usually change between otherwise identical
// lines: UUIDs, long hex IDs, then any run of digits.
function shapeOf(line) {
    return line
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '#')
        .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, '#')
        .replace(/\d+/g, '#');
}
// Lines that may report a problem are never merged with lines that differ from
// them. Byte-identical copies are still counted, since nothing is hidden.
const problem = /\b(?:errors?|fail(?:ed|ure|ures|s)?|fatal|panic|exception|warn(?:ing|ings)?|denied|traceback|critical|abort(?:ed)?)\b/i;
/**
 * Generic reduction for any command. Runs of three or more byte-identical,
 * non-blank adjacent lines keep one copy plus a count. At the similar level,
 * runs of four or more lines that match after masking numbers and IDs keep
 * the first and last line plus a count. Problem lines and lines without words
 * are never merged by similarity.
 */
function collapseRepeatedLines(text, similarLines) {
    const lines = linesOf(text);
    let removedLines = 0;
    let similarUsed = false;
    let result = '';
    const ending = (line) => line.endsWith('\n') ? '' : '\n';
    for (let index = 0; index < lines.length;) {
        const first = plain(lines[index]);
        let end = index + 1;
        if (first.trim())
            while (end < lines.length && plain(lines[end]) === first)
                end++;
        if (end - index >= 3) {
            const repeats = end - index;
            result += lines[index] + `${ending(lines[index])}${repeatedLineNote}${repeats} times; ${repeats - 1} duplicate copies archived]\n`;
            removedLines += repeats - 1;
            index = end;
            continue;
        }
        if (similarLines && first.trim() && !problem.test(first)) {
            const shape = shapeOf(first);
            if (shape !== first && /[A-Za-z]{2,}/.test(shape)) {
                end = index + 1;
                while (end < lines.length && !problem.test(plain(lines[end])) && shapeOf(plain(lines[end])) === shape)
                    end++;
                const count = end - index;
                if (count >= 4) {
                    const last = lines[end - 1];
                    result += lines[index] + `${ending(lines[index])}${similarLinesNote}${count - 2} lines between these differ only in numbers or IDs; originals archived]\n` + last;
                    removedLines += count - 2;
                    similarUsed = true;
                    index = end;
                    continue;
                }
            }
        }
        result += lines[index++];
    }
    return { adapter: similarUsed ? 'similar-lines' : 'repeated-lines', text: result, removedLines };
}
function reduceKnownFormat(adapter, text) {
    if (adapter === 'tsc')
        return collapseTsc(text);
    if (adapter === 'js-test')
        return removeLines(text, 'jest') ?? removeLines(text, 'vitest');
    if (adapter === 'pytest' || adapter === 'jest' || adapter === 'vitest')
        return removeLines(text, adapter);
    if (adapter === 'phpstan') {
        if (!/^\s*\[(?:OK|ERROR)\]/m.test(text))
            return;
    }
    else if (adapter === 'phpunit') {
        if (!/^PHPUnit \d+\.\d+/m.test(text) || !/^(?:OK \(|FAILURES!|ERRORS!|Tests:|OK, but there were issues!)/m.test(text))
            return;
    }
    else if (!/^\s*(?:Tests:|PASS\s|FAIL\s)/m.test(text))
        return;
    return removeProgress(text, adapter);
}
export function reduceRecognizedOutput(input, text, options = {}) {
    // ANSI-rich and carriage-return output has cursor semantics we cannot safely
    // reconstruct. Preserve it, including progress written over previous lines.
    if (/\u001b|\r(?!\n)/.test(text))
        return;
    // A recognized single direct invocation uses its format adapter first.
    const adapter = adapterFor(input);
    const known = adapter ? reduceKnownFormat(adapter, text) : undefined;
    if (known && known.text !== text)
        return known;
    // Anything else, including pipelines, only gets the generic line reduction.
    const level = options.level ?? 'standard';
    if (level === 'strict')
        return known;
    const generic = collapseRepeatedLines(text, level === 'similar');
    if (generic.text !== text)
        return generic;
    return known;
}
