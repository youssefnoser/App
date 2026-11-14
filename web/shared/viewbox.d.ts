export const LOAD_FOV_DEG: number;
export const SEQ_MIN_FOV_DEG: number;
export const SEQ_MAX_FOV_DEG: number;
export const MAX_FOV_DEG: number;
export function zoomFov(fovDeg: number, factor: number): number;
export function frameBox(fovDeg: number, width: number, height: number): number | null;
export function boxCovers(box: { ra: number; dec: number; fov: number }, c: { ra: number; dec: number }, fovDeg: number, width: number, height: number): boolean;
