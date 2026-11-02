/** Disposable survival movement regression; never connects to the live port. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createCobbleBob } from '../src/minecraft/bot.js';
import { recoverSuppliesInField } from '../src/skills/field-craft.js';
import pino from 'pino';
import { WorldActionExecutor } from '../src/agent/world-actions.js';
import { travelHomeAndWait } from '../src/minecraft/movement.js';
const port = Number(process.env.BLOCKHEAD_SMOKE_PORT);
if (process.env.BLOCKHEAD_DISPOSABLE_TEST !== '1' || port !== 25599) throw Error('disposable port 25599 only');
const bot = createCobbleBob({ server: { host:'127.0.0.1',port,username:'HomeTest' } } as never);
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const timeout=setTimeout(()=>{bot.quit();process.exit(1)},180000);
try {
 await once(bot,'spawn'); await delay(1000);
 for(const command of ['/fill 14 58 -44 30 58 8 stone','/fill 14 59 -44 30 78 8 air','/fill 19 59 -3 26 67 4 stone','/fill 21 68 -1 23 74 1 birch_planks','/fill 22 68 0 22 74 0 air','/tp HomeTest 21.5 68 2.5','/clear HomeTest','/gamemode survival HomeTest']){bot.chat(command);await delay(200)}
 await delay(1000);
 assert.ok(bot.entity.position.distanceTo({x:21.5,y:68,z:2.5} as never) < 0.1, "fixture setup requires operator access");
 assert.equal(bot.inventory.items().length, 0);
 const controller=new AbortController();
 const executor=new WorldActionExecutor();
 const result=await executor.run('return-home-repro',controller.signal,()=>travelHomeAndWait(bot,{x:22,y:59,z:-40,dimension:'overworld'},{signal:controller.signal,timeoutMs:90000}));
 console.log(JSON.stringify({result,position:bot.entity.position}));
 assert.ok(['arrived','already_there'].includes(result.status));
 for(const command of ['/fill 28 67 -2 34 67 4 dirt','/fill 28 68 -2 34 73 4 air','/fill 31 68 0 31 70 0 oak_log','/fill 30 71 -1 32 71 1 oak_leaves','/tp HomeTest 29.5 68 0.5','/clear HomeTest']){bot.chat(command);await delay(200)}
 await delay(1000);
 await executor.run('field-supply-recovery',controller.signal,()=>recoverSuppliesInField(bot,pino(),controller.signal));
 assert.ok(bot.inventory.items().some(item=>item.name==='wooden_pickaxe'), 'field recovery must pick up its punched logs and craft a pickaxe');
 console.log('PASS: bounded field recovery punched wood, collected drops, placed a table and made a pickaxe');
} finally {clearTimeout(timeout);bot.quit()}
