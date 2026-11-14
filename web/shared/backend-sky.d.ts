export type SkyPosition = {ra:number;dec:number};
export type FrameMeta = {wavelength_um?:number;detector?:number;[key:string]:unknown};
export type BackendStep = {uri:string;mjd:number;date:string;detector:number;meta:FrameMeta|null};
export type BackendTimeline = {steps:BackendStep[];index:number};
export type BandWindow = {wavelength:number;width:number;detector?:number}|{detector:number};
export const HIPS: string;
export function readSkyCentre(stel:any):SkyPosition;
export function pointSky(stel:any,centre:SkyPosition):void;
export function frameAddress(sequence:any,uri:string,clean?:boolean):string;
export function createBackendSky(stel:any,options?:{
 onTimeline?:(timeline:BackendTimeline)=>void;
 onStatus?:(status:string)=>void;
 onView?:(centre:SkyPosition)=>void;
 fetchFn?:typeof fetch;
}): {
 refresh:(centre:SkyPosition,fov:number,aspect?:number)=>Promise<void>;
 setBands:(windows:BandWindow[],backgroundFrame:number)=>void;
 setVisible:(visible:boolean)=>void;
 setFill:(fill:boolean)=>void;
 showFrame:(index:number)=>void;
 retry:()=>void;
 destroy:()=>void;
};
