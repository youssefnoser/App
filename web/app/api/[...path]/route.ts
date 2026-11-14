export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const allowed = /^(targets|view|sequence|gaia|gaia\/source\/\d{1,19}|frame\.png|patch\/\d+\/frame\.png)$/;
export async function GET(request: Request, context: {params:Promise<{path:string[]}>}) {
  const {path} = await context.params;
  const route=path.join('/');
  if(!allowed.test(route)) return Response.json({detail:'Unknown endpoint.'},{status:404});
  const target=new URL(`/api/${route}`,process.env.SPHEREX_BACKEND_URL || 'http://130.61.174.88:8000');
  target.search=new URL(request.url).search;
  try {
    const upstream=await fetch(target,{cache:'no-store',signal:AbortSignal.any([request.signal,AbortSignal.timeout(180000)])});
    const headers=new Headers();
    for(const key of ['content-type','cache-control','x-frame-meta','etag','last-modified']) {
      const value=upstream.headers.get(key);if(value) headers.set(key,value);
    }
    return new Response(upstream.body,{status:upstream.status,headers});
  } catch {return Response.json({detail:'The SPHEREx backend did not answer. Try again.'},{status:502});}
}
