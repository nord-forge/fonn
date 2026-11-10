// The nine checks shown in the visualiser, and the text each one shows.
// The decision itself always comes from the real filter; this module only
// maps the filter's reason code onto the check where it stopped.
import { formatNumber } from './format.js';

export const STAGES = [
  { id: 'mode', title: 'Filter mode' },
  { id: 'shape', title: 'Plain shell text' },
  { id: 'fresh', title: 'Not already filtered' },
  { id: 'size', title: 'At least 2,000 characters' },
  { id: 'format', title: 'Recognized format or repeated lines' },
  { id: 'reduce', title: 'Safe reduction exists' },
  { id: 'savings', title: 'Saves at least 256 characters' },
  { id: 'archive', title: 'Original archived' },
  { id: 'deliver', title: 'Delivered to the model' },
];

// Filter reason code to the check that produced it.
const STOP_AT = {
  disabled: 'mode',
  unsupported_response: 'shape',
  already_filtered: 'fresh',
  below_minimum_characters: 'size',
  unrecognized_format: 'format',
  no_safe_reduction: 'reduce',
  below_minimum_savings: 'savings',
  archive_or_parse_failed: 'archive',
};

// Index of the check where the filter stopped, or of the last check when it
// went all the way through.
export function stopIndexFor(reason) {
  const stopId = STOP_AT[reason];
  return {
    stopped: Boolean(stopId),
    index: stopId ? STAGES.findIndex((stage) => stage.id === stopId) : STAGES.length - 1,
  };
}

// Why the format check declined. This is only a label for the reader.
function explainFormat(command, text, level) {
  if (/\u001b|\r(?!\n)/.test(text)) return 'Terminal colour codes or carriage returns. Left alone.';

  const noGeneric = {
    strict: 'The strict level skips the generic reduction.',
    standard: 'No runs of identical lines either.',
    similar: 'No identical or similar line runs either.',
  }[level];

  const trimmed = command.trim();
  if (/[\n\r;&|<>`$'"\\]/.test(trimmed)) return `Pipe, chaining or quote skips the format adapters. ${noGeneric}`;

  const tokens = trimmed.split(/\s+/);
  if (tokens[0] === 'php') tokens.shift();
  if (['npx', 'pnpm', 'yarn'].includes(tokens[0])) tokens.shift();
  const tool = (tokens[0] ?? '').split('/').pop();
  const known = ['phpunit', 'pest', 'tsc', 'pytest', 'jest', 'vitest'].includes(tool)
    || (tool === 'phpstan' && /^analy[sz]e$/.test(tokens[1] ?? ''))
    || (tool === 'artisan' && tokens[1] === 'test');

  if (!known) return `No adapter for this command. ${noGeneric}`;
  return `The tool's summary markers are missing. ${noGeneric}`;
}

function formatPassText(adapter) {
  if (adapter === 'repeated-lines') return 'identical line runs found';
  if (adapter === 'similar-lines') return 'similar line runs found';
  return `${adapter ?? ''} adapter`;
}

// Text for each check: [shown when it passed, shown when it stopped there].
export function stageDetails({ decision, mode, level, command, stdout, proposed }) {
  const saved = proposed === undefined ? 0 : decision.originalCharacters - proposed.length;
  const characters = formatNumber(decision.originalCharacters);
  return {
    mode: [`mode is ${mode}, level ${level}`, 'mode is off. No reduction is attempted.'],
    shape: ['stdout text', 'Not plain stdout text.'],
    fresh: ['No earlier Fonn footer', 'Already carries a Fonn note.'],
    size: [`${characters} characters`, `Only ${characters} characters.`],
    format: [formatPassText(decision.adapter), explainFormat(command, stdout, level)],
    reduce: [`${formatNumber(decision.removedLines)} lines removable`, 'Nothing safe to remove.'],
    savings: [`${formatNumber(saved)} characters saved, footer included`, 'The saving would not cover the footer.'],
    archive: [decision.artifactId ? `stored as ${decision.artifactId.slice(0, 8)}` : 'stored', 'Archiving failed, so the original is delivered.'],
  };
}

export function deliverText(status) {
  if (status === 'filtered') return 'Shortened text plus recovery footer';
  if (status === 'observed') return 'Full output. Observe mode only records the reduction';
  return 'Original output, unchanged';
}
