export function cachedFetch(input:string|URL,options?:{signal?:AbortSignal}):Promise<Response>;
export function createFrontendCache(options?:{fetchFn?:typeof fetch;storage?:CacheStorage|null;maxBytes?:number;maxEntries?:number;now?:()=>number}):{fetch:typeof cachedFetch};
