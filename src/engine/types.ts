export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Category = 'location' | 'device' | 'time' | 'people' | 'software' | 'preview' | 'hidden' | 'technical';
export type Format = 'jpeg' | 'png' | 'webp' | 'heic' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'mp4';

export interface Finding {
  id: string; category: Category; severity: Severity; label: string; value: string; why: string; source: string;
  /** false = Hushprint can show this but cannot remove it losslessly. It is listed as a caveat after cleaning. */
  removable?: boolean;
}
export interface GpsFix { lat: number; lon: number; altitude?: number; accuracyM?: number; nearest: { name: string; km: number }[] }
export interface Thumb { bytes: Uint8Array; width?: number; height?: number; mismatch: boolean }
export interface Risk { level: Severity; headline: string; bullets: string[] }
export interface Analysis {
  name: string; size: number; format: Format; width: number; height: number; orientation: number;
  findings: Finding[]; gps?: GpsFix; thumbnail?: Thumb; risk: Risk; warnings: string[];
  /** 0 (exposed) to 100 (nothing found). A heuristic over the findings, not a guarantee. */
  score: number;
  /** Short facts such as "MOV" or "3 revisions" to show beside the format. */
  detail?: string;
}
export interface CleanResult {
  bytes: Uint8Array; before: Analysis; after: Analysis;
  removed: Finding[];
  /** Findings that are still in the output because Hushprint cannot remove them losslessly. Empty = fully clean. */
  remaining: Finding[];
  /** No identifying metadata left except `remaining`, and the content is intact. */
  verified: boolean;
  /** Pixels / pages / media streams are byte-for-byte what they were. False after a re-encode. */
  pixelsIdentical: boolean;
  /** The file was decoded and encoded again (HEIC export, or baking rotation into pixels). */
  reencoded: boolean;
  outFormat: Format;
  orientationKept: number;
}

export const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
export const CATEGORY_TITLE: Record<Category, string> = {
  location: 'Where you were', device: 'What you shot it with', time: 'When', people: 'Who you are',
  software: 'Software trail', preview: 'Hidden previews & leftovers', hidden: 'Notes, captions & IDs', technical: 'Camera settings',
};
export const FORMAT_LABEL: Record<Format, string> = {
  jpeg: 'JPEG', png: 'PNG', webp: 'WebP', heic: 'HEIC', pdf: 'PDF', docx: 'DOCX', xlsx: 'XLSX', pptx: 'PPTX', mp4: 'MP4/MOV',
};
/** Formats the browser can show as a normal <img>. */
export const isPreviewable = (f: Format) => f === 'jpeg' || f === 'png' || f === 'webp';
export const EXTENSION: Record<Format, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', heic: 'heic', pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx', mp4: 'mp4' };
export const MIME: Record<Format, string> = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', mp4: 'video/mp4',
};

export class UnsupportedFormat extends Error {}
export class NeedsReencode extends Error {}
