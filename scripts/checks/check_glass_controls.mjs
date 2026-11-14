// Manual browser regression check against a running dev app and real backend.
import assert from 'node:assert/strict';
import {globSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {chromium} from '../../web/node_modules/@playwright/test/index.mjs';
const browser=await chromium.launch({executablePath:globSync('/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux-arm64/chrome-headless-shell')[0],headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];const requests=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{if(r.url().includes('/api/frame.png')&&r.ok())requests.push(r.url());});
 await page.goto((process.env.NEXT_CHECK_URL||'http://localhost:5173/')+'#ra=269.4521&dec=4.6934&fov=0.083333');
 await page.waitForFunction(()=>!!window.__stel,{timeout:60000});
 const band=page.getByRole('button',{name:'Choose infrared bands',exact:true});
 await band.click();
 await page.waitForTimeout(350);
 assert.equal(await band.evaluate(e=>getComputedStyle(e).opacity),'1');
 assert.equal(await band.evaluate(e=>getComputedStyle(e).pointerEvents),'auto');
 await band.click();
 assert.equal(await band.getAttribute('aria-expanded'),'false');
 await band.hover();
 assert.equal(await band.evaluate(e=>getComputedStyle(e).borderTopColor),'rgba(255, 255, 255, 0.48)');
 for(const name of ['Toggle Gaia DR3 overlay']) {
  const b=page.getByRole('button',{name,exact:true});await b.click();await page.waitForTimeout(250);
  assert.equal(await b.evaluate(e=>getComputedStyle(e).boxShadow),'none');
  assert.equal(await b.evaluate(e=>getComputedStyle(e).backdropFilter),'none');
  await b.click();
 }
 assert.equal(await page.getByRole('button',{name:'Toggle WISE overlay',exact:true}).count(),0);
 assert.equal(await page.locator('.wise-pin').count(),0);
 await mkdir('.cache/ui-regressions',{recursive:true});
 await page.screenshot({path:'.cache/ui-regressions/desktop.png'});
 for(const name of ['Difference','Previous visit','Trail','Raw']) {
  const button=page.getByRole('button',{name,exact:true});await button.click();
  assert.equal(await button.getAttribute('aria-pressed'),'true');
 }
 await page.waitForFunction(()=>document.querySelector('#time-knob')?.textContent.includes('2025'),{timeout:120000});
 await page.screenshot({path:'.cache/ui-regressions/real-frames.png'});
 await page.setViewportSize({width:390,height:844});
 await band.click();await page.waitForTimeout(350);
 assert.equal(await band.evaluate(e=>getComputedStyle(e).opacity),'1');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.equal(await page.locator('.band-pop-close').evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
 await page.screenshot({path:'.cache/ui-regressions/mobile.png'});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({errors,frames:requests.length,checks:'band remains visible and toggles closed; neutral hover; overlays have no glow/blur; all four filters select; mobile fits'}));
} finally {await browser.close();}
