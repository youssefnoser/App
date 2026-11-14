// Manual browser check against the running development app and real backend.
import assert from 'node:assert/strict';
import {globSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {chromium} from '../../web/node_modules/@playwright/test/index.mjs';
const browser=await chromium.launch({executablePath:globSync('/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux-arm64/chrome-headless-shell')[0],headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:1366,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto((process.env.NEXT_CHECK_URL||'http://localhost:5173/')+'#ra=269.4521&dec=4.6934&fov=0.083333');
 await page.waitForFunction(()=>!!window.__stel,{timeout:60000});
 await page.evaluate(()=>window.__zenEngine=window.__stel);
 await page.keyboard.press('Tab');
 assert.equal(await page.locator('main').getAttribute('data-zen'),'true');
 assert.equal(await page.locator('.search-dock').isVisible(),false);
 assert.equal(await page.locator('.map-tools').isVisible(),false);
 assert.equal(await page.locator('.timeline').isVisible(),false);
 assert.equal(await page.locator('#object-label').isVisible(),false);
 assert.equal(await page.locator('#stel-canvas').isVisible(),true);
 assert.equal(await page.evaluate(()=>window.__zenEngine===window.__stel),true);
 await mkdir('.cache/ui-regressions',{recursive:true});
 await page.screenshot({path:'.cache/ui-regressions/zen.png'});
 await page.keyboard.press('Tab');
 assert.equal(await page.locator('.search-dock').isVisible(),true);
 await page.locator('.search-dock input').focus();await page.keyboard.press('Tab');
 assert.notEqual(await page.locator('main').getAttribute('data-zen'),'true');
 await page.evaluate(()=>document.activeElement?.blur());
 await page.keyboard.press('Shift+Tab');
 assert.notEqual(await page.locator('main').getAttribute('data-zen'),'true');
 await page.evaluate(()=>document.activeElement?.blur());
 await page.keyboard.press('Tab');await page.keyboard.press('Escape');
 assert.equal(await page.locator('.map-tools').isVisible(),true);
 assert.deepEqual(errors,[]);
 console.log('PASS: Tab hides/restores UI, Escape restores, typing and Shift+Tab keep navigation; sky engine survives.');
} finally {await browser.close();}
