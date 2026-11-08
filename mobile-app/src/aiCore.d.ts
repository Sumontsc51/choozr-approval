import type { AiIssue, AiResult, Measurement } from './types';
export interface StatsDoc { approved: number; rejected: number; pairs: Record<string, { n: number; mean: number; m2: number }>; names: Record<string, any>; }
export function toCm(value: string): number | null;
export function keyOf(name: string): string;
export function emptyStats(): StatsDoc;
export function learnApproved(s: StatsDoc, ms: Measurement[]): StatsDoc;
export function learnRejected(s: StatsDoc, ms: Measurement[], reason: string): string[];
export function learnCorrection(s: StatsDoc, rejected: Measurement[], approved: Measurement[]): { name: string; fromCm: number; toCm: number; pct: number }[];
export function mentionedIn(reason: string, ms: Measurement[]): string[];
export function risk(s: StatsDoc, key: string): number;
export function check(s: StatsDoc, ms: Measurement[], minSamples?: number): { issues: AiIssue[]; flags: Record<string, string>; scores: Record<string, number>; learned: boolean; note: string };
export function combine(st: ReturnType<typeof check>, claude: null, forVersion: number, model: string): AiResult;
export function lessonKind(decision: 'approved' | 'rejected', ai: AiResult | null, hadRejectedBefore: boolean): 'fixed' | 'missed' | 'false_alarm' | null;
