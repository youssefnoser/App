import { chromium } from '../web/node_modules/@playwright/test/index.mjs';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:1366,height:900}});
 const errors=[];const sequences=[];const oldMapRequests=[];let frames=0;
 page.on('request',request=>{if(/\/skydata\/(stars|dso|surveys\/milkyway|skycultures)/.test(request.url())) oldMapRequests.push(request.url());});
 page.on('pageerror',error=>errors.push(error.message));
 page.on('response',response=>{if(response.url().includes('/api/sequence'))sequences.push({url:response.url(),status:response.status()});if(response.url().includes('/api/frame.png')&&response.ok())frames++;});
 await page.goto(process.env.NEXT_CHECK_URL || 'http://localhost:5173/');
 await page.waitForFunction(()=>!!window.__stel,{timeout:30000});
 await page.waitForFunction(()=>document.querySelector('#time-knob')?.textContent.includes('2025'),{timeout:60000});
 await mkdir('.cache/acceptance',{recursive:true});
 await page.screenshot({path:'.cache/acceptance/next-backend-desktop.png'});
 console.log(JSON.stringify({errors,sequences,frames,timeline:await page.locator('#time-knob').innerText(),status:await page.locator('.map-bottom').innerText()}));
 const mapState=await page.evaluate(()=>{
   const core=window.__stel.core;
   // Stars, DSOs and the Milky Way draw nothing without a data source; planets would.
   return {planets:core.planets.visible,survey:core.dss.visible};
 });
 if(mapState.planets || !mapState.survey || oldMapRequests.length) throw Error(`Old map still present: ${JSON.stringify({mapState,oldMapRequests})}`);
 await page.getByRole('button',{name:'Visible',exact:true}).click();
 if(!await page.evaluate(()=>window.__stel.core.dss.visible)) throw Error('SPHEREx background was hidden');
 await page.getByRole('button',{name:'Infrared',exact:true}).click();
 console.log('Only the index.html survey is active; no old map data requests.');
 await page.getByRole('button',{name:'Next frame',exact:true}).click();
 await page.getByRole('button',{name:'Choose infrared bands',exact:true}).click();
 await page.getByRole('checkbox',{name:'Detector 1, local band 2, global band 2',exact:true}).check();
 await page.getByRole('button',{name:'Close band selection',exact:true}).click();
 await page.waitForTimeout(1000);
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'.cache/acceptance/next-backend-mobile.png'});
 console.log(JSON.stringify({afterBandChange:sequences.at(-1),errors}));
 await page.setViewportSize({width:1366,height:900});
 await page.getByRole('button',{name:'Toggle Gaia DR3 overlay',exact:true}).click();
 await page.locator('.gaia-pin').waitFor({state:'visible'});
 await page.getByRole('button',{name:'Toggle WISE overlay',exact:true}).click();
 await page.locator('.wise-pin').waitFor({state:'visible'});
 await page.getByRole('button',{name:'Open advanced options',exact:true}).click();
 await page.getByRole('button',{name:'Image Math',exact:true}).click();
 await page.getByLabel('Image operation').selectOption('add');
 await page.locator('.math-band-picker-container').waitFor({state:'visible'});
 await page.getByRole('button',{name:'Close advanced options',exact:true}).click();
 const engineCount = await page.locator('script[data-stel-engine]').count();
 if(engineCount !== 1) throw Error(`Expected one engine script, saw ${engineCount}`);
 console.log('Existing advanced drawer, image-math controls, overlays and responsive UI are present.');
 if(errors.length) throw Error(errors.join('\n'));
} finally {await browser.close();}
