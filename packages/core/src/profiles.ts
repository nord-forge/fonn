import type { ProfileName, TaskProfile } from './contracts.js';

export const profiles: Readonly<Record<ProfileName, TaskProfile>> = Object.freeze({
  'opus-high': Object.freeze({ name: 'opus-high', model: 'claude-opus-5-5', effort: 'high' }),
  'opus-medium': Object.freeze({ name: 'opus-medium', model: 'claude-opus-5-5', effort: 'medium' }),
  'sonnet-medium': Object.freeze({ name: 'sonnet-medium', model: 'claude-sonnet-5-5', effort: 'medium' }),
});

export function getProfile(name: string = 'opus-medium'): TaskProfile {
  if (!Object.hasOwn(profiles, name)) throw new Error(`Unknown profile: ${name}. Choose ${Object.keys(profiles).join(', ')}.`);
  return profiles[name as ProfileName];
}
