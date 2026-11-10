// Illustrative tool observations shared by the visualiser and the docs build.
// The build runs every sample through the compiled filter at each level and
// fails when the real decision no longer matches `levels`. `expect` is the
// standard-level decision; `expectStrict` and `expectSimilar` default to it.

const dots = (count) => '.'.repeat(count);

function phpunitRun(perLine, lineCount, { failure = true } = {}) {
  const total = perLine * lineCount;
  const lines = ['PHPUnit 11.5.2 by Sebastian Bergmann and contributors.', '', 'Runtime:       PHP 8.4.1', 'Configuration: /app/phpunit.xml', ''];
  for (let done = perLine; done <= total; done += perLine) {
    const row = failure && done === total ? dots(40) + 'F' + dots(perLine - 41) : dots(perLine);
    lines.push(`${row} ${String(done).padStart(String(total).length)} / ${total} (${String(Math.floor((done / total) * 100)).padStart(3)}%)`);
  }
  lines.push('', 'Time: 00:06.204, Memory: 52.00 MB', '');
  if (failure) {
    lines.push('There was 1 failure:', '', '1) Tests\\Feature\\InvoiceTest::test_zero_limit_is_preserved',
      'Failed asserting that 20 is identical to 0.', '', '/app/tests/Feature/InvoiceTest.php:42', '',
      'FAILURES!', `Tests: ${total}, Assertions: ${total * 3}, Failures: 1.`);
  } else {
    lines.push(`OK (${total} tests, ${total * 3} assertions)`);
  }
  return lines.join('\n') + '\n';
}

function pestRun() {
  const lines = [''];
  for (let i = 0; i < 30; i++) lines.push(`  ${dots(60)} ${String((i + 1) * 60).padStart(4)} / 1800 (${String(Math.floor(((i + 1) / 30) * 100)).padStart(3)}%)`);
  lines.push('', '  WARN  Tests\\Unit\\LegacyMailerTest', '  ! it sends the legacy template → This test is marked as risky.', '',
    '  Tests:    1 risky, 1799 passed (5112 assertions)', '  Duration: 9.41s', '');
  return lines.join('\n');
}

function phpstanRun() {
  const total = 1480;
  const lines = [' Note: Using configuration file /app/phpstan.neon.', ''];
  for (let done = 40; done <= total; done += 40) {
    const width = 28;
    const filled = Math.round((done / total) * width);
    lines.push(` ${String(done).padStart(4)}/${total} [${'▓'.repeat(filled)}${'░'.repeat(width - filled)}] ${String(Math.floor((done / total) * 100)).padStart(3)}%`);
  }
  lines.push('', ' ------ ---------------------------------------------------', '  Line   app/Billing/InvoiceLimit.php',
    ' ------ ---------------------------------------------------', '  18     Method resolve() should return int but returns int|null.',
    ' ------ ---------------------------------------------------', '', ' [ERROR] Found 1 error', '');
  return lines.join('\n');
}

function pytestRun() {
  const lines = ['============================= test session starts ==============================', 'platform linux -- Python 3.12.4, pytest-8.3.3, pluggy-1.5.0', 'rootdir: /app', 'collected 1440 items', ''];
  const files = ['tests/test_api.py', 'tests/test_billing.py', 'tests/test_models.py', 'tests/test_utils.py'];
  let done = 0;
  for (const file of files) {
    for (let row = 0; row < 6; row++) {
      done += 60;
      const body = file === 'tests/test_billing.py' && row === 2 ? dots(20) + 'F' + dots(39) : dots(60);
      const prefix = row === 0 ? `${file} ` : '';
      lines.push(`${prefix}${body}${' '.repeat(Math.max(1, 73 - prefix.length - body.length))}[${String(Math.floor((done / 1440) * 100)).padStart(3)}%]`);
    }
  }
  lines.push('', '=================================== FAILURES ===================================', '_______________________________ test_zero_limit ________________________________', '',
    '    def test_zero_limit():', ">       assert resolve_limit({'limit': 0}) == 0", 'E       assert 20 == 0', '', 'tests/test_billing.py:42: AssertionError',
    '=========================== short test summary info ============================', 'FAILED tests/test_billing.py::test_zero_limit - assert 20 == 0',
    '======================= 1 failed, 1439 passed in 11.82s ========================', '');
  return lines.join('\n');
}

function jestRun() {
  const lines = ['> app@1.4.0 test', '> jest', ''];
  for (let i = 0; i < 60; i++) lines.push(`PASS src/module${String(i).padStart(2, '0')}/feature.test.ts`);
  lines.push('FAIL src/billing/limit.test.ts', '  resolveLimit', '    ✓ uses the default when missing (3 ms)', '    ✕ keeps zero (4 ms)', '',
    '  ● resolveLimit › keeps zero', '', '    expect(received).toBe(expected) // Object.is equality', '', '    Expected: 0', '    Received: 20', '',
    '      at Object.toBe (src/billing/limit.test.ts:41:40)', '',
    'Test Suites: 1 failed, 60 passed, 61 total', 'Tests:       1 failed, 487 passed, 488 total', 'Snapshots:   0 total', 'Time:        9.412 s', 'Ran all test suites.', '');
  return lines.join('\n');
}

function tscRun() {
  const repeated = "src/generated/client.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.";
  const lines = [];
  for (let i = 0; i < 28; i++) lines.push(repeated);
  lines.push("src/billing/limit.ts(7,10): error TS2367: This comparison appears to be unintentional because the types 'number' and 'string' have no overlap.", '', 'Found 29 errors in 2 files.', '');
  return lines.join('\n');
}

function heartbeatRun() {
  const lines = ['BEGIN_TASK_PAYLOAD', '{"task":"preserve zero values","code":"return input.limit || 20;"}', 'END_TASK_PAYLOAD'];
  for (let i = 0; i < 48; i++) lines.push(`PROGRESS worker=${i % 4} status=healthy heartbeat=ok`);
  lines.push('OBSERVATION_COMPLETE exit=0', '');
  return lines.join('\n');
}

function waitingRun() {
  const lines = ['> app@1.4.0 dev', '> node server.js', '', 'Starting server on port 3000'];
  for (let i = 0; i < 60; i++) lines.push('Waiting for database connection on localhost:5432...');
  lines.push('Database connected after 61 attempts', 'Server ready at http://localhost:3000', '');
  return lines.join('\n');
}

function ansiRun() {
  return phpunitRun(63, 32, { failure: false }).replace(/^OK \(/m, '\u001b[30;42mOK (').replace(/assertions\)$/m, 'assertions)\u001b[0m');
}

export const samples = [
  {
    id: 'phpunit', label: 'PHPUnit', command: 'vendor/bin/phpunit', stdout: phpunitRun(63, 32), expect: 'safe_reduction',
    blurb: 'Progress rows made only of dots are removed. The row containing F stays, and so does every failure detail.',
  },
  {
    id: 'pest', label: 'Pest', command: 'php artisan test', stdout: pestRun(), expect: 'safe_reduction',
    blurb: 'Pest progress rows go. The risky-test warning and the summary stay.',
  },
  {
    id: 'phpstan', label: 'PHPStan', command: 'vendor/bin/phpstan analyse', stdout: phpstanRun(), expect: 'safe_reduction',
    blurb: 'Progress bar rows are dropped once PHPStan prints its [OK] or [ERROR] verdict. The error table stays.',
  },
  {
    id: 'tsc', label: 'tsc duplicates', command: 'npx tsc --noEmit', stdout: tscRun(), expect: 'safe_reduction',
    blurb: 'Adjacent byte-identical diagnostics collapse to one copy with a count. Different diagnostics are kept.',
  },
  {
    id: 'pytest', label: 'pytest', command: 'python -m pytest', stdout: pytestRun(), expect: 'safe_reduction',
    blurb: 'Rows made only of dots go. The row with F, the failure details and the summary stay.',
  },
  {
    id: 'jest', label: 'Jest', command: 'npm test', stdout: jestRun(), expect: 'safe_reduction',
    blurb: 'npm test is allowed because Jest prints its own totals. PASS lines and the passing ✓ line go. The failing file, ✕ and the totals stay.',
  },
  {
    id: 'repeated', label: 'Repeated lines', command: 'npm run dev 2>&1 | head -n 200', stdout: waitingRun(), expect: 'safe_reduction', expectStrict: 'unrecognized_format',
    blurb: 'Any command, even a pipeline: at the standard level, 60 identical lines become one line and an exact count. Every distinct line stays. Strict leaves it alone.',
  },
  {
    id: 'heartbeat', label: 'Heartbeat log', command: 'node scripts/worker.js', stdout: heartbeatRun(), expect: 'unrecognized_format', expectSimilar: 'safe_reduction',
    blurb: 'Only the worker number changes, so no two adjacent lines are identical and the standard level passes it through. Switch to the similar level to keep the first and last line and drop the rest.',
  },
  {
    id: 'pipe', label: 'Piped command', command: 'vendor/bin/phpunit | tee test.log', stdout: phpunitRun(63, 32), expect: 'unrecognized_format',
    blurb: 'Same PHPUnit output, but a pipeline makes its origin ambiguous, so the PHPUnit adapter is skipped. The generic reduction runs instead and finds no identical or wordy similar lines.',
  },
  {
    id: 'ansi', label: 'Coloured output', command: 'vendor/bin/phpunit', stdout: ansiRun(), expect: 'unrecognized_format',
    blurb: 'Terminal colour codes or carriage returns carry cursor meaning Fonn cannot rebuild safely, so it leaves the text alone.',
  },
  {
    id: 'short', label: 'Short run', command: 'vendor/bin/phpunit --filter InvoiceTest', stdout: phpunitRun(20, 2, { failure: false }), expect: 'below_minimum_characters',
    blurb: 'Under 2,000 characters there is little to gain, so short output is never touched.',
  },
].map((sample) => ({ ...sample, levels: { strict: sample.expectStrict ?? sample.expect, standard: sample.expect, similar: sample.expectSimilar ?? sample.expect } }));
