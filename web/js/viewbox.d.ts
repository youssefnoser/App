export const LOAD_FOV_DEG: number;
export const SEQ_MIN_FOV_DEG: number;
export const SEQ_MAX_FOV_DEG: number;
type Box = {ra:number;dec:number;fov:number};
type Centre = {ra:number;dec:number};
export function frameBox(fovDeg:number,width:number,height:number):number|null;
export function boxCovers(box:Box,c:Centre,fovDeg:number,width:number,height:number):boolean;
export function boxOnScreen(box:Box,c:Centre,fovDeg:number,width:number,height:number):boolean;
export function boxInside(inner:Box,outer:Box):boolean;
