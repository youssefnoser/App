export type GaiaSource = {
  source_id: string;
  ra: number;
  dec: number;
  pmra: number | null;
  pmdec: number | null;
  parallax: number | null;
  gmag: number | null;
  fast?: boolean;
};
export type QueryKind =
  | { kind: 'coords'; ra: number; dec: number }
  | { kind: 'coords-invalid' }
  | { kind: 'gaia-id'; id: string }
  | { kind: 'name'; name: string }
  | { kind: 'empty' };
export type SesameResult = { name: string; ra: number; dec: number; pmra: number | null; pmdec: number | null };
type Moving = { ra: number; dec: number; pmra?: number | null; pmdec?: number | null };

export const GAIA_EPOCH_MJD: number;
export const J2000_MJD: number;
export const FAST_PM_MASYR: number;
export function mjdNow(now?: number): number;
export function propagate(src: Moving, mjd: number, epochMjd?: number): { ra: number; dec: number };
export function totalPm(src: Moving): number | null;
export function markerKind(src: Moving): 'fast' | 'bright';
export function classifyQuery(text: string): QueryKind;
export function sesameUrl(name: string): string;
export function parseSesame(xml: string): SesameResult | null;
export function tooltipLines(src: GaiaSource): string[];
