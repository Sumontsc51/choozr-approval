export type Status = 'pending' | 'approved' | 'rejected' | 'archived';
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
  archivedAt: string;      // ISO or ''
  archivedBy: string;
  deleteAt: string;        // ISO or '' — archived orders are deleted at this time
  rise: string[];          // e.g. ['High rise']
  riseSpecific: string;    // free text, e.g. '11.5 in'
  note: string;            // coordinator's note for the approver
  marks: Marks;            // approver's drawings on the photos
  ai: AiResult | null;
}

/** A drawing on a photo. Coordinates are 0..1 of the image (x of width, y of height). */
export type Shape =
  | { type: 'pen'; color: string; w?: number; pts: number[] }                 // flat [x0,y0,x1,y1,…]; w = thickness
  | { type: 'line'; color: string; w?: number; a: number[]; b: number[] }
  | { type: 'circle'; color: string; w?: number; a: number[]; r: number }     // centre, radius as a share of the width
  | { type: 'text'; color: string; a: number[]; text: string };
export interface Marks { front: Shape[]; side: Shape[]; }

export interface Profile { uid: string; exists: boolean; email: string; name: string; role: Role | null; }
