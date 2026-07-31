import { chromium } from 'playwright';
import { WEBGPU_FLAGS, CHROMIUM_CHANNEL } from './chromium-flags.mjs';

/**
 * **`--port` はここで読むこと。以前はポート 5173 が埋め込まれていた。**
 *
 * 他のツール (capture / baseline / profile) はすべて `--port` を受けるので、
 * このツールも受けているつもりで `--port=5190` のように呼んでいた。実際には無視され、
 * **毎回 5173 の別サーバーを測っていた**。「変更前と変更後」を比べたつもりが、
 * どちらも同じ第三のサーバーの数字だったことになる。
 *
 * ゲートが黙って別のものを測るのは、ゲートが無いより悪い。
 */
const args = Object.fromEntries(process.argv.slice(2).map((a)=>{
  const m=a.match(/^--([^=]+)(?:=(.*))?$/); return m?[m[1],m[2]??true]:[a,true];
}));
const PORT = Number(args.port ?? 5173);
const QUERY = typeof args.query === 'string' ? `&${args.query}` : '';

const b = await chromium.launch({ headless: true, channel: CHROMIUM_CHANNEL, args: WEBGPU_FLAGS });
const p = await b.newPage({ viewport:{width:1280,height:720} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>m.type()==='error'&&errs.push(m.text()));
await p.goto(`http://127.0.0.1:${PORT}/?backend=webgpu${QUERY}`, {waitUntil:'domcontentloaded'});
await p.waitForFunction('window.__READY__===true',null,{timeout:60000});
const snap = () => p.evaluate(()=>{const e=window.__ENGINE__,c=e.camera.position;return{
  pos:[+c.x.toFixed(2),+c.y.toFixed(2),+c.z.toFixed(2)],
  yaw:+e.camera.rotation.y.toFixed(3), frame:e.time.frame,
  systems:Object.keys(e.ctx).length}});
const a = await snap();
// hold W for ~40 frames
await p.evaluate(()=>{const e=window.__ENGINE__; e.input.enabled=true; e.input.frozen=false;
  e.ctx.peek('player')?.setControlEnabled?.(true);});
await p.keyboard.down('w');
await p.evaluate(()=>new Promise(d=>{let i=0;const t=()=>++i>=45?d():requestAnimationFrame(t);requestAnimationFrame(t)}));
await p.keyboard.up('w');
const bpos = await snap();
// fire a shot via the input layer
const fired = await p.evaluate(()=>{let n=0; const off=window.__ENGINE__.events.on('weapon:fire',()=>n++);
  const w=window.__ENGINE__.ctx.peek('weapons'); try{ w?.debugPose?.('fire',{grabFrame:1}); }catch(e){}
  return new Promise(d=>{let i=0;const t=()=>++i>=30?(off(),d(n)):requestAnimationFrame(t);requestAnimationFrame(t)})});
// count scene objects + check for NaN transforms
/**
 * シーンの健全性チェック。
 *
 * Three 版は scene.traverse で走査していたが、Babylon には traverse が無いので
 * `scene.meshes` / `scene.transformNodes` を直接見る。ビューモデルは別シーンでは
 * なく renderingGroupId で区別されるので、group 1 のメッシュ数を数える
 * (core/engine.js の RENDER_GROUP を参照)。
 *
 * **NaN の検出が要点**。物理やアニメーションが壊れると座標が NaN になり、
 * メッシュが描画から静かに消える。エラーは一切出ないので、明示的に見るしかない。
 */
const health = await p.evaluate(()=>{const e=window.__ENGINE__; let nan=0, vm=0;
  const all=[...e.scene.meshes, ...e.scene.transformNodes];
  for(const o of all){ const v=o.position; if(!Number.isFinite(v.x+v.y+v.z)) nan++; }
  for(const m of e.scene.meshes){ if(m.renderingGroupId===1) vm++; }
  return {worldObjects:all.length, viewmodelObjects:vm, nanTransforms:nan,
          activeMeshes:e.scene.getActiveMeshes().length,
          fps:+(1000/(e.time.dt*1000||16.6)).toFixed(0)}});
const moved = Math.hypot(bpos.pos[0]-a.pos[0], bpos.pos[2]-a.pos[2]);
console.log(JSON.stringify({ready:true, startPos:a.pos, afterW:bpos.pos, metresMoved:+moved.toFixed(2),
  framesAdvanced:bpos.frame-a.frame, fireEvents:fired, ...health, errors:errs.slice(0,8)},null,2));
await b.close();
