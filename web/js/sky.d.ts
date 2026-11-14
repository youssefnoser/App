export type ScreenPoint = {x:number;y:number;visible:boolean};
export type Sky = {
 stel:any;
 core:any;
 layer:any;
 viewCentre:()=>{ra:number;dec:number};
 fovDeg:()=>number;
 flyTo:(ra:number,dec:number,fovDeg?:number)=>void;
 toScreen:(ra:number,dec:number,width:number,height:number)=>ScreenPoint;
};
export const ENGINE_SCRIPT: string;
export function loadEngine(src?:string,env?:{win?:any;doc?:any}):Promise<any>;
export function initSky(canvas:HTMLCanvasElement,options?:{frame?:number}):Promise<Sky>;
export function makeSky(stel:any,frame:number):Sky;
export function projectView(v:number[],fov:number,width:number,height:number):ScreenPoint;
