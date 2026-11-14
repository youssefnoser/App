export type SkyPosition = {ra:number;dec:number};
export type FrameMeta = {wavelength_um?:number;detector?:number;[key:string]:unknown};
export type BackendStep = {uri:string;mjd:number;date:string;detector:number;meta:FrameMeta|null};
export type BackendTimeline = {steps:BackendStep[];index:number};
export type LoadPhase = 'zoomed-out'|'hidden'|'finding'|'loading'|'cleaning'|'ready'|'failed'|'empty'|'error';
export type LoadProgress = {phase:LoadPhase;done:number;total:number;failed:number;cleaned:number};
export type BandWindow = {wavelength:number;width:number;detector?:number}|{detector:number};
import type { Sky } from './sky.js';
export function frameAddress(sequence:any,uri:string,clean?:boolean):string;
export function createBackendSky(sky:Sky,options?:{
 onTimeline?:(timeline:BackendTimeline)=>void;
 onStatus?:(status:string)=>void;
 onProgress?:(progress:LoadProgress)=>void;
 onView?:(centre:SkyPosition)=>void;
 fetchFn?:typeof fetch;
}): {
 refresh:(centre:SkyPosition,fov:number,aspect?:number)=>Promise<void>;
 setBands:(windows:BandWindow[],backgroundFrame:number)=>void;
 setVisible:(visible:boolean)=>void;
 setFill:(fill:boolean)=>void;
 setFilter:(filter:'raw'|'difference'|'previous'|'trail')=>void;
 showFrame:(index:number)=>void;
 retry:()=>void;
 destroy:()=>void;
};
