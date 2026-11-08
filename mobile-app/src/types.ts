export type Status = 'pending' | 'approved' | 'rejected';
export type Role = 'approver' | 'coordinator' | 'admin';

export interface Measurement { name: string; value: string; cm: number | null; }

export interface AiIssue {
  measurement: string;
  view: 'front' | 'side' | 'both' | 'unknown';
  severity: 'low' | 'medium' | 'high';
  problem: string;
  source: 'stats' | 'claude';
}
export interface AiResult {
  status: 'queued' | 'running' | 'done' | 'error' | 'off';
  forVersion: number;
  verdict?: 'ok' | 'check' | 'wrong';
  score?: number;
  summary?: string;
  issues?: AiIssue[];
  flags?: Record<string, string>;
  engines?: string[];
  model?: string;
  error?: string;
}

export interface Order {
  id: string;
  orderNo: string;
  customer: string;
  title: string;
  measuredAt: string;
  pageUrl: string;
  coordinator: string;
  status: Status;
  version: number;
  rejectCount: number;
  exportedAt: string;      // ISO
  decidedAt: string;       // ISO or ''
  decidedBy: string;
  reason: string;
  validatedCount: number;
  totalCount: number;
  measurements: Measurement[];
  images: { front: string; side: string };
  ai: AiResult | null;
}

export interface Profile { uid: string; exists: boolean; email: string; name: string; role: Role | null; }
