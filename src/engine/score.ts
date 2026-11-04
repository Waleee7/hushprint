// Privacy score. Transparent on purpose: a capped penalty per finding, nothing hidden.
//   critical -60 · high -20 · medium -8 · low -2 · info 0
//   each severity has a ceiling so one noisy file cannot hide behind a pile of small items, and GPS coordinates cap the score at 25.
import type { Finding, Severity } from './types.ts';

const PENALTY: Record<Severity, number> = { critical: 60, high: 20, medium: 8, low: 2, info: 0 };
const CEILING: Record<Severity, number> = { critical: 80, high: 40, medium: 24, low: 8, info: 0 };

export const privacyScore = (findings: Finding[]): number => {
  const spent: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    if (f.label === 'Orientation') continue; // kept on purpose and harmless alone
    spent[f.severity] = Math.min(CEILING[f.severity], spent[f.severity] + PENALTY[f.severity]);
  }
  let score = 100 - (spent.critical + spent.high + spent.medium + spent.low);
  if (findings.some((f) => f.category === 'location' && f.severity === 'critical')) score = Math.min(score, 25);
  return Math.max(0, Math.min(100, score));
};

export type ScoreBand = 'quiet' | 'low' | 'leaky' | 'exposed';
export const scoreBand = (n: number): ScoreBand => (n >= 90 ? 'quiet' : n >= 70 ? 'low' : n >= 40 ? 'leaky' : 'exposed');
export const BAND_LABEL: Record<ScoreBand, string> = { quiet: 'Quiet', low: 'Low exposure', leaky: 'Leaky', exposed: 'Exposed' };

/** A batch is only as private as its worst file: one leaked address is enough. */
export const batchScore = (scores: number[]): number | undefined => (scores.length ? Math.min(...scores) : undefined);
