import type { FilterDecision, OutputFilter, OutputFilterOptions, ToolObservation } from '../contracts.js';
import { reduceRecognizedOutput, repeatedLineNote, ruleNote, similarLinesNote } from './adapters.js';
export { createArtifactStore } from './artifact-store.js';

export function createOutputFilter(options: OutputFilterOptions): OutputFilter {
  const minimumCharacters = options.minimumCharacters ?? 2_000;
  const minimumSavings = options.minimumSavingsCharacters ?? 256;
  if (!Number.isSafeInteger(minimumCharacters) || minimumCharacters < 0 || !Number.isSafeInteger(minimumSavings) || minimumSavings < 0) {
    throw new Error('Invalid filter thresholds');
  }

  return {
    async apply(observation: ToolObservation) {
      const response = observation.response;
      const record = response !== null && typeof response === 'object' && !Array.isArray(response) ? response as Record<string, unknown> : undefined;
      const stdout = typeof response === 'string' ? response : typeof record?.stdout === 'string' ? record.stdout : undefined;
      const originalCharacters = stdout?.length ?? 0;
      let decision: FilterDecision = {
        mode: options.mode, status: 'unchanged', originalCharacters,
        proposedCharacters: originalCharacters, deliveredCharacters: originalCharacters,
        removedLines: 0, reason: 'unsupported_response',
      };
      function finish(delivered: unknown) {
        // Reporting must never break delivery of the original tool result.
        try { options.onDecision?.({ ...decision }); } catch { /* metrics callback is advisory */ }
        return { response: delivered, decision };
      }
      if (options.mode === 'off') {
        decision.reason = 'disabled';
        return finish(response);
      }
      if (stdout === undefined || record?.interrupted || record?.isImage || record?.type === 'image' || record?.is_error || record?.content) return finish(response);
      if (['[fonn: full original tool response archived as ', '[fonn: identical diagnostic occurred ', repeatedLineNote, similarLinesNote, ruleNote].some((note) => stdout.includes(note))) {
        decision.reason = 'already_filtered';
        return finish(response);
      }
      if (originalCharacters < minimumCharacters) {
        decision.reason = 'below_minimum_characters';
        return finish(response);
      }
      try {
        const reduction = reduceRecognizedOutput(observation.toolInput, stdout, { level: options.level ?? 'standard', rules: options.rules ?? [] });
        if (!reduction) {
          decision.reason = 'unrecognized_format';
          return finish(response);
        }
        decision.adapter = reduction.adapter;
        decision.proposedCharacters = reduction.text.length;
        decision.removedLines = reduction.removedLines;
        if (reduction.text === stdout) {
          decision.reason = 'no_safe_reduction';
          return finish(response);
        }
        // Reserve enough room for the recovery footer before archiving anything.
        const footerFor = (id: string) => {
          const hint = options.recoveryHint?.(id) ?? `mcp__fonn__read_output({"id":"${id}"})`;
          return `\n[fonn: full original tool response archived as ${id}; recover with ${hint}.]\n`;
        };
        if (originalCharacters - reduction.text.length - footerFor('00000000-0000-4000-8000-000000000000').length < minimumSavings) {
          decision.reason = 'below_minimum_savings';
          return finish(response);
        }
        const artifact = await options.store.save({
          toolName: observation.toolName, sessionId: observation.sessionId,
          toolUseId: observation.toolUseId, response,
        });
        // The store is an extension point: never render an unvalidated id into output.
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(artifact.id)) throw new Error('Invalid archive id');
        const proposed = reduction.text + footerFor(artifact.id);
        if (originalCharacters - proposed.length < minimumSavings) {
          decision.reason = 'below_minimum_savings';
          return finish(response);
        }
        decision = { ...decision, artifactId: artifact.id, proposedCharacters: proposed.length,
          status: options.mode === 'observe' ? 'observed' : 'filtered',
          deliveredCharacters: options.mode === 'observe' ? originalCharacters : proposed.length,
          reason: options.mode === 'observe' ? 'reduction_observed' : 'safe_reduction',
        };
        if (options.mode === 'observe') return finish(response);
        return finish(typeof response === 'string' ? proposed : { ...record, stdout: proposed });
      } catch {
        decision.status = 'unchanged';
        decision.reason = 'archive_or_parse_failed';
        decision.deliveredCharacters = originalCharacters;
        return finish(response);
      }
    },
  };
}
