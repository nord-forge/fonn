import { z } from 'zod';

export const handoffSchema = z.object({
  agent: z.enum(['explorer', 'reviewer']),
  task: z.string().min(1),
  findings: z.array(z.string()),
  evidence: z.array(z.object({ path: z.string(), line: z.number().int().positive().optional(), note: z.string() }).strict()),
  unresolved: z.array(z.string()),
}).strict();

export const taskResultSchema = z.object({
  summary: z.string().min(1),
  changes: z.array(z.string()),
  checks: z.array(z.object({ name: z.string(), status: z.enum(['passed', 'failed', 'not_run']), details: z.string() }).strict()),
  unresolved: z.array(z.string()),
  handoffs: z.array(handoffSchema),
}).strict();

export const taskResultJsonSchema = z.toJSONSchema(taskResultSchema);
