// Filter rule schemas. Kept apart from settings.ts so profiles.ts can use
// them for global rules without an import cycle.
import { z } from 'zod';

/**
 * A filter rule: for commands starting with `command`, remove lines that
 * contain any `remove` text. Plain text only, so a rule can never hang the
 * filter, and lines that mention a problem are never removed.
 */
export const filterRuleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  command: z.string().trim().min(1).max(200).refine((value) => !/[\n\r\0]/.test(value), 'One line only'),
  remove: z.array(z.string().min(3, 'Use at least 3 characters').max(200).refine((value) => !/[\n\r\0]/.test(value), 'One line only')).min(1).max(20),
}).strict();
export const filterRulesSchema = z.array(filterRuleSchema).max(50).refine(
  (rules) => new Set(rules.map((rule) => rule.name)).size === rules.length,
  'Rule names must be unique',
);

/**
 * Global, shared and personal rules after merging: up to 50 from each file.
 * Launch and run records store this list, so they use this bound.
 */
export const mergedFilterRulesSchema = z.array(filterRuleSchema).max(150);
