# OVERWATCH — engine contract

**Every agent must read this before writing code. It is the only coordination mechanism.**

Target: a browser FPS whose *visual and tactile quality* stands next to a modern
Call of Duty. **Babylon.js 9 + WebGPU + Havok**, no external art assets — all
textures, meshes, animation and audio are generated procedurally at load time.

> **移植メモ**: このプロジェクトは Three.js r180 + WebGL2 から移植された。移植前の
> 実装は `git show main:<path>` で参照できる。この契約ファイルは「なぜそうなっているか」
> と「後続の作業者が踏む罠」を記録する **欠陥メモリ** として運用すること。新しい罠を
> 踏んだら必ずここに書き足す — それが二度目の犠牲者を出さない唯一の方法。

## Hard rules

1. **You own your directory. Never edit files outside it.** Another agent owns
   every other directory and your edit will be clobbered or will break them.
2. **Never import another subsystem's module.** Get it at runtime:
   `const fx = ctx.get('fx')`. This is what makes parallel work safe.
3. **No new npm dependencies.** `@babylonjs/core`, `@babylonjs/havok`,
   `@babylonjs/materials` only. No CDN fetches, no external
   images/HDRIs/models/audio files — the game must run fully offline.
4. **No `Math.random()` in gameplay or visuals.** Use `ctx.rng` (see
   `src/core/rng.js`) or a `ctx.rng.fork()` you keep. Capture reproducibility
   depends on it.
5. **Allocate nothing per-frame.** Preallocate vectors, matrices and arrays in
   `init()` and reuse. A `new Vector3()` inside `update()` is a bug.
6. **Dispose what you create.** Geometries, materials, textures and render
   targets get freed in `dispose()`.
7. `npm run build` must pass, `node tools/wgsl-lint.mjs` must be clean, and
   `node tools/capture.mjs --shot=hero` must produce a **non-black** frame after
   your change. If you break the boot, nobody else can work.

## Subsystem interface

```js
export class MySystem {
  static id = 'mysystem';       // unique; how others reach you
  static deps = ['render'];     // ids that must init before you

  async init(ctx) {}            // build resources; may await
  fixedUpdate(h, ctx) {}        // optional, 120 Hz, deterministic gameplay
  update(dt, ctx) {}            // optional, once per frame
  lateUpdate(dt, ctx) {}        // optional, after all update()
  resize(w, h, ctx) {}          // optional
  dispose() {}                  // optional
}
```

`ctx` provides: `scene`, `camera`, `canvas`, `config`, `events`, `input`,
`time`, `rng`, `backend`, `LAYER`, `RENDER_GROUP`, `get(id)`, `peek(id)`, `has(id)`.

- `scene` — **唯一の Babylon Scene**。ワールドもビューモデルも同じシーンに居る。
- `camera` — **唯一のカメラ**。理由は下の「ビューモデル」節を参照。
- `backend` — `'webgpu'` | `'webgl2'`。機能分岐に使う。
- `time` — `{ elapsed, raw, dt, fixed, alpha, scale, frame }`. Use `alpha` to
  interpolate rendered transforms between physics steps.
- `config.q` — the active quality preset (see `src/core/config.js`). Respect
  `q.taa`, `q.gtao`, `q.motionBlur`, `q.clusteredLights`, `q.shadowMapSize`,
  `q.particleBudget`, `q.decalBudget`. Never exceed a budget.

## Ownership map

| id | directory | owns |
|---|---|---|
| `render` | `src/render/` | Babylon のパイプライン設定、CSM、clustered lighting、露出、ポストチェイン |
| `materials` | `src/materials/` | WGSL 手続きテクスチャ鍛冶場、共有マテリアルライブラリ |
| `sky` | `src/sky/` | 物理大気、太陽/月、時刻、IBL (SH)、フォグ |
| `world` | `src/world/` | レベルジオメトリ、建物、プロップ、静的コリジョン、実用光源 |
| `physics` | `src/physics/` | Havok のラッパ。raycast/shapecast、キャラクタ、剛体、弾道 |
| `player` | `src/player/` | 移動ステートマシン、カメラの触感、体力 |
| `weapons` | `src/weapons/` | 武器メッシュ、ビューモデル、ADS、反動、リロード、弾道 |
| `fx` | `src/fx/` | GPU パーティクル、マズルフラッシュ、曳光弾、着弾、デカール、煙 |
| `ai` | `src/ai/` | 敵キャラクタ、ナビ、索敵、カバー、戦闘行動 |
| `ui` | `src/ui/` | HUD、クロスヘア、ヒットマーカー、被弾表示、弾数、キルフィード |
| `audio` | `src/audio/` | 合成音、空間化、リバーブ、遮蔽、ミックス |

Shared, owned by the lead (do not edit): `src/core/`, `src/main.js`,
`src/dev/`, `tools/`, `vite.config.js`.

## Cross-subsystem events

Emit and listen via `ctx.events`. Payloads are plain objects. The canonical set:

| event | payload | emitted by |
|---|---|---|
| `weapon:fire` | `{ weapon, origin: Vector3, dir: Vector3, seed }` | weapons |
| `weapon:reload` | `{ weapon, phase: 'start'\|'magout'\|'magin'\|'end' }` | weapons |
| `weapon:shell` | `{ position, velocity }` | weapons |
| `bullet:impact` | `{ point, normal, incident, surface, damage, exit, actor, part }` | physics |
| `bullet:tracer` | `{ from, to, speed }` | weapons |
| `damage:dealt` | `{ target, amount, headshot, killed, point }` | ai / physics |
| ↳ | means *damage dealt **to** `target`*. `target` is the local player when an enemy round connects (`'player'`, the player system, or anything with `isPlayer === true`) — filter it out before drawing a hitmarker. **Damage is applied by the target's own listener, never by the emitter as well.** | |
| `damage:taken` | `{ amount, from: Vector3, health }` | player |
| `actor:death` | `{ actor, point, impulse }` | ai / player |
| `player:land` | `{ velocity, surface, position }` | player |
| `player:footstep` | `{ position, surface, running }` | player |
| `player:state` | `{ stance, sprinting, sliding, ads, ... }` | player |
| `explosion` | `{ position, radius, damage }` | any |
| `resize` | `{ width, height }` | engine |

If you need an event that is not listed, add a row here in the same commit.

## Surface types

Shared vocabulary for impact FX, decals, audio and footsteps. Physics tags every
body with one of: `concrete`, `metal`, `wood`, `dirt`, `sand`, `glass`,
`water`, `foliage`, `fabric`, `flesh`, `rubber`, `plaster`.
(`src/physics/surfaces.js` — Three 非依存だったのでそのまま再利用している)

---

# 罠と設計判断 (defect memory)

ここから下は **実際に踏んだ罠と、その回避のために下した設計判断** の記録。
「なぜこう書いてあるか」が分からないコードに出会ったら、まずここを探すこと。

## ビューモデル — 1 カメラ + renderingGroupId

Three 版は `scene` と `viewScene` の 2 シーン構成で、ビューモデル専用のライトリグを
持っていた。その結果 README に記録された既知バグが生まれた:

> viewmodel の light rig が world の約 20 倍の irradiance を出しており、view scene
> では *黒* のマテリアルですら L=110 (背景 91) で描かれる。全武器の albedo を物理値の
> 1/3 に誤魔化して辻褄を合わせているため、最も注視されるオブジェクトのマテリアル
> 表現力が頭打ち。

原因は「2 つの独立した照明環境を人手で一致させ続ける」構造そのもの。

移植時にまず `activeCameras` に 2 台並べる構成を試したが **これは誤り**だった:
**Babylon のポストプロセスはカメラ単位で適用される**ため、パイプラインを 1 台目にだけ
付けるとビューモデルにトーンマップも露出も掛からず、両方に付けるとポストが 2 回走る。
どちらも「照明環境が 2 つある」病に戻る。

**正解は 1 カメラ + renderingGroupId**:

```
RENDER_GROUP.WORLD     = 0   ワールド
RENDER_GROUP.VIEWMODEL = 1   ビューモデル (このグループの手前で深度のみクリア)
```

深度クリアで銃は壁を貫通しない。ポストチェインは 1 本なので、ビューモデルは定義上
ワールドと同一の露出・同一の IBL で焼かれる。

**代償 (意図的に受け入れているもの)**:
- ビューモデルは `camera.minZ` (0.05 m) より手前に置けない
- ADS でワールド FOV を絞ると武器も一緒にスケールする。weapons 側が ADS 遷移で
  位置と姿勢を動かして吸収する

**ビューモデル専用のライトを追加しないこと。** 追加した時点で上の事故が再発する。

## LEVEL 空間と WORLD 空間 — 数時間を溶かした罠

`src/world/layout.js` の座標は「通りが -Z に走る **LEVEL 空間**」で書かれている。
一方、カメラショット (`src/dev/shots.js`)、スポーン、AI の配置は「回転済みの
**WORLD 空間**」で書かれている。

変換は `WorldBuilder.setTransform(LEVEL_YAW, LEVEL_TX, LEVEL_TZ)` が持つ。

最初の Babylon 移植でこの変換が**丸ごと欠落**し、hero カメラ (12, 1.75, 18) が東側の
建物の**内部**に埋まった。症状は「空が真っ黒」で、大気シェーダのバグに見えた。実際には
シェーダは正常で、カメラが屋内に居ただけだった。

**座標データを触るときは必ずこの 2 空間の区別を意識すること。** また、メッシュでない
座標データ (街灯の灯具位置、窓明かりの PointLight など) は `builder.toWorld()` を
通すこと。通し忘れるとライトだけが回転前の位置に取り残される。

## beginFrame() / endFrame() を自分で呼ぶこと

Babylon の通常の使い方は `engine.runRenderLoop(() => scene.render())` で、**この
runRenderLoop がフレームの前後で `beginFrame()` / `endFrame()` を呼んでいる**。

このプロジェクトは決定的キャプチャのために自前でループを回している
(`src/core/engine.js` の `step()`) ので、その 2 つは誰も呼んでくれない。

WebGL では省いてもほぼ動くが、**WebGPU では `endFrame()` がコマンドバッファの submit と
present を行う**。省くと:

- 例外は一切出ない
- `scene.getActiveIndices()` は正しい値を返す (シーンは「描いている」)
- しかしキャンバスは完全に真っ黒

`src/render/index.js` の `render()` がこの 3 行を持っている。消さないこと。

## 副作用 import — 消してはいけない「使っていない import」

Babylon 9 は **エンジンの機能もツリーシェイキングする**。以下は import しないと
機能そのものが存在せず、しかも一段先で落ちるため原因が分かりにくい:

| import | 無いとどうなるか |
|---|---|
| `Physics/joinedPhysicsEngineComponent.js` | `scene.enablePhysics` が生えず、`getPhysicsEngine()` が undefined を返し「Cannot read properties of undefined (reading 'setTimeStep')」 |
| `Materials/Textures/baseTexture.polynomial.js` | `sphericalPolynomial` が生えない。PBR は「反射がキューブなら SH を使う」と決め打つため、描画のたび `BindIBLParameters` が `polynomials.l00` で落ちる |
| `Engines/Extensions/engine.multiRender.js` | `createMultipleRenderTarget is not a function` (WebGL 系) |
| `Engines/WebGPU/Extensions/engine.multiRender.js` | 同上 (WebGPU 系)。**上とは別物で両方必要** |

いずれも lint やエディタの「未使用 import の自動削除」で消されやすい。消したら
必ず上の症状で戻ってくる。

## SSAO2 と MotionBlur の経路衝突

両者とも depth/normal/velocity を必要とするが、既定では前者が
GeometryBufferRenderer、後者が prepass から取ろうとする。2 つの経路が同時に生きると
WebGPU のバインドグループが食い違い、**両方を有効にしたときだけ**毎フレーム
`Failed to execute 'createBindGroup' ... 'resource' ... Required member is undefined`
で落ちる。

二分探索で確かめた挙動 (q=high, 640x360):

| 設定 | pageerror |
|---|---|
| `taa=0` | 9 件 (TAA は無関係) |
| `gtao=0` | 0 件 |
| `mblur=0` | 0 件 |
| `clustered=0` | 12 件 (clustered も無関係) |

**両方を `forceGeometryBuffer = true` に揃える**と経路が 1 本になり解消する。

## IBL の球面調和は空モデルから直接作る

当初 `CubeMapToSphericalPolynomialTools` でプローブのキューブから SH を計算していたが、
**WebGPU では RenderTargetTexture の同期読み戻しができず null が返る**。そして PBR は
「反射テクスチャがキューブなら SH を使う」と決め打つので、描画のたびに落ちる。

現在は大気モデルを CPU 側で 64 方向サンプリングして SH を直接構築している
(`src/sky/index.js` の `_bakeEnv` / `_skyColorFor`)。読み戻しも非同期待ちも不要で確実。

**限界**: これは GGX 事前フィルタではない。README の「Indirect light — an
approximation, not real GI」という自己評価はこの構成でも引き続き当てはまる。

## clustered lighting — 旧契約の警告は「もう該当しない」

Three 版のこの節には長い警告があった:

> 可視 point light の数が Three のマテリアル program cache key に含まれる。ランプ
> 1 個が減衰半径を跨いで `visible=false` になるだけで、シーン内の全 lit マテリアルが
> 再コンパイルされる。実測 +33〜36 programs / 640〜900ms、900 フレーム中 5 回。

回避のため world 側 (`_stabiliseLightCount`) と fx 側の両方に「強度 0 のバラストライトで
可視数を固定する」仕掛けを抱えていた。

**Babylon 9 の `ClusteredLightContainer` ではこの問題が原理的に発生しない**
(シェーダから見たライト数が常に一定)。バラストも距離カリングも不要。ライトは
`render.addLight(light)` に渡すだけでよい。

`q.clusteredLights = false` で無効化できるが、その経路では上の問題が再発しうる。

## 影キャスタは明示登録のみ — ビューモデルを登録しないこと

Babylon の `ShadowGenerator` は **カメラの layerMask も renderingGroupId も見ない**。
自身の shadow caster リストに入っているメッシュだけを深度パスに描く。

この構成では `render.addShadowCaster(mesh)` を呼んだものだけが影を落とす
(world と ai が呼ぶ)。**weapons は呼んでいないので、ビューモデルが世界のカスケードに
焼き込まれることはない。**

ただし 1 Scene 化により「ビューモデルもワールドと同じシーンに居る」ため、将来
「シーン全体を走査して影キャスタにする」ような実装に変えると、**銃が世界に影を落とす**
という Three 版には存在しなかったバグが生まれる。`owNoShadow` メタデータを
`addShadowCaster` が弾く仕組みは残してあるが、**そもそも登録しない**のが第一の防衛線。

## WebGPU の頂点バッファは 8 スロットまで — 超えるとフレーム全体が黒くなる

`maxVertexBuffers = 8`。fx のパーティクルで属性 8 本をそれぞれ別バッファに持たせた
ところ、`position` + `uv` + 8 = **10 スロット**になり CreateRenderPipeline が失敗した:

    Vertex buffer count (10) exceeds the maximum number of vertex buffers (8).

**症状が原因と全く結びつかない**のがこの罠の厄介さ。不正なパイプラインを SetPipeline
した時点で **そのフレームのコマンドバッファ全体が invalid になり Queue.Submit ごと
捨てられる**ため:

- 粒子を 1 つ出すだけで **画面全体** が真っ黒 (hero の平均輝度 84 → 6)
- フラグメントを完全透明の固定出力にしても黒い (出力内容は無関係)
- シェーダにサイズを固定で埋めると板が出る
  (**未使用属性が effect から削られてスロットが 8 以下に収まるため**。
   「属性が全部ゼロで届く」ように見えたのも同根)
- `?post=0` でも黒い (ポストとの相互作用ではない)
- thin instance に変えても黒い (同じ上限)

**対処**: 8 本を stride 128 byte の 1 本のインターリーブ Buffer にまとめ、
`Buffer.createVertexBuffer` で view を切り出す。Babylon の WebGPU 実装
(`webgpuCacheRenderPipeline._getVertexInputDescriptor`) は「同一 GPU バッファを連続
参照する属性」を 1 layout にまとめるので、**position + uv + データ = 3 スロット**に収まる。
アップロードも 8 回 → 1 回になる。

**頂点属性を増やすときは常にスロット数を数えること。**

## GPU エラーは「最初の 1 件」だけが原因を名指しする

上の不具合の調査が長引いた直接の原因は **ハーネス側の欠陥**だった。

WebGPU では 1 件の不正パイプラインが以降のすべてを巻き添えにするので、ログは
「invalid due to a previous error」で埋まる。`tools/capture.mjs` は以前 **末尾 60 行**
しか出しておらず、表示されるのは巻き添えばかりで **原因を名指しする 1 次エラーが必ず
流れて消えていた**。そのため「ポストプロセスとの相互作用」という誤った仮説を長く追った。

さらに **Babylon は uncaptured error を `console.warn` で流す** (error ではない)。
type で error だけを拾うフィルタでは捕まらない。

`capture.mjs` は 1 次エラーを抽出して先頭に出すようになっている (`firstGpuError`)。
**新しいハーネスを書くときも、末尾ではなく先頭を出すこと。**

## TAA は `clampHistory` を必ず有効にすること

Babylon の `TAARenderingPipeline` は `clampHistory` (履歴ピクセルを周囲 3x3 の
min/max にクランプする neighborhood clamping) が **既定 false**。これが無い TAA は
「履歴 92% + 現フレーム 8%」の単純な指数移動平均でしかなく、**数フレームしか存在
しない現象を完全に潰す**。

実測 (muzzle ショット, lockstep, 銃口 1000-1090 x 620-690 の最大輝度。発射前後
14 フレームを 1 フレームずつ):

| 設定 | 最大輝度 | ピーク位置 |
|---|---|---|
| taa なし | 219-255 | 銃口 (1044-1046, 652-659) |
| taa あり (既定) | 196-208 | 矩形の角 = **フラッシュ無し** |
| taa あり + clampHistory | 212-229 | 銃口 (1049-1054, 659-666) |

マズルフラッシュの寿命は 40-62 ms = 2-3 フレーム。撮影のタイミングの問題ではなく
**実プレイでも銃口は光っていなかった**。一過性の FX (フラッシュ、火花、閃光手榴弾) を
足すときは、この設定が生きていることを前提にしてよい。

### 目視だけで「写っていない」と判断しないこと

この調査を長引かせたのは自分の誤判断だった。`taa=0` の画像を目視だけで
「フラッシュなし」と読み、そこから「ポストプロセスが犯人」という誤った枝に入った。
同じ画像を数値で測ると max 230 が銃口位置に立っていた。

「エラーが出ない = 動いた、ではない」の裏返しで、**明るい背景に対する局所ピークは
目視では埋もれる**。目視と数値の両方を取ること。矩形を決めて最大輝度と**その位置**を
出すのが確実で、位置が矩形の角なら「背景しか無い」ことが機械的に分かる。

## 一過性イベントを狙うショットはロックステップでのみ撮れる

`tools/capture.mjs` は以前 engine の rAF ループを止めずに撮っていた。ドライバが往復
している間 (`__READY__` の待ち、ショット適用、スクリーンショットの RPC) にもフレームが
進むので、`__APPLY_SHOT__` に渡す `grabFrame` と**実際のシャッターフレームが一致しない**
(実測で frame 209 / 255 のように毎回違った)。

`baseline.mjs` は元からロックステップだったが `capture.mjs` は違っており、その差が
「baseline では写るのに capture では写らない」という切り分けを難しくしていた。現在は
`capture.mjs` も既定でロックステップ (`--lockstep=0` で従来動作)。

## Havok / Babylon の罠 (実測で踏んだもの)

### PhysicsCharacterController の内部 body はフィルタ全ビット

`PhysicsCharacterController` は内部で `PhysicsBody` を作り、**フィルタが全ビット立った
状態**になっている。つまり弾のレイに当たる。しかもその body は physics のメタデータ表に
載っていないので:

- `hit.surface` が既定の 'concrete' になる (肉なのにコンクリ音・コンクリ片)
- `hit.actor` が null なので **damage:dealt が発行されず、ダメージが入らない**

実測 (修正前): 8m 手前からプレイヤーへ撃つと 7.75m で
`{surface:'concrete', hasActor:false}` に当たり、**体力が一切減らなかった**。

`physics.createCharacter({ actor, surface, part })` を渡せばメタデータ表に登録される。
別途ヒットボックスを持つキャラクタ (ai) は `bulletProof: true` でフィルタを CLIP に
落とし、弾と視線から外すこと。

**CC の内部 body は private (`ctrl._body`)**。public な取得手段が無いので直接触っている。
Babylon を上げたときに名前が変わっていないか確認すること — 変われば静かに登録されなくなり、
「弾が当たるのにダメージが入らない」状態に戻る (エラーは出ない)。

### kinematic ボディはワールド追加後に動かすと raycast に当たらなくなる

実座標だけが動き、query broadphase が追従しない (最小再現で確認済み)。ai の部位
ヒットボックスは毎フレーム `RemoveBody` → `AddBody` で回避している
(`src/ai/hitbox.js`)。**kinematic を動かす実装を足すときは同じ罠を踏む。**

### WebGPU の fragment 入力は 16 変数まで

頂点カラー + CSM 4 カスケードで 17 になり、**画面全体が黒くなる**。ai は
`forceIrradianceInFragment = true` で回避した。**頂点カラー付きマテリアルを追加する
ときは要注意。**

### matricesIndices は Float32 で渡す

`Uint16Array` を渡すと頂点フォーマットが食い違い、メッシュが爆発する。

## WGSL の罠

`node tools/wgsl-lint.mjs` が (1) と (2) を検出する。**コミット前に必ず通すこと。**

1. **予約語**: `macro` / `type` / `set` / `shared` / `sample` など。使うとシェーダ
   モジュールの生成が失敗するが、**Babylon の `isReady()` は true を返し、`render()` も
   例外を投げず、テクスチャは真っ黒のまま焼き上がる**。エラーは GPUValidationError として
   ブラウザ console にしか出ない。
2. **WGSL テンプレートリテラル内の JSDoc にバッククォートを書かない**。リテラルが
   そこで終端し、「Unexpected identifier 'eye'」のような **原因と全く無関係に見える
   JS 構文エラー**になる。この移植で 3 回踏んだ。
3. **ヘルパ関数は `main` より前に定義する**。Babylon はシェーダ末尾に
   `return fragmentOutputs;` を注入するため、後ろに関数があるとその中に入って型エラーになる。
4. **関数の前方参照は許されない**。使う側より前に定義すること。
5. **演算子の混在には明示の括弧が要る**。`a * b ^ c * d` は
   「mixing '*' and '^' requires parenthesis」で落ちる (C と違い暗黙の優先順位を許さない)。
6. **`vec4f` の uniform は `setVector4` で渡す**。`setFloats` は float 配列用で、
   `UniformBuffer.updateUniformArray` の中で落ちる。
7. **`sin` ベースのハッシュを使わない**。GPU ベンダごとに `sin` の精度が違い、同じ
   コードが別マシンで別の絵を出す。整数ハッシュで書くこと (`src/materials/wgsl/noise.js` 参照)。
8. **「コンパイルが通った」を「動いた」と読み替えない**。`tools/matbake.mjs` は
   焼き上がりの分散・平均・法線の向きまで見て合否を出す。この統計ゲートが無ければ
   予約語の事故はゲーム起動後まで発見できなかった。

## Vite の設定

Babylon はシェーダのチャンクを **動的 import** で遅延ロードする。esbuild の
pre-bundle を通すとこの動的 import が解決できず
「Failed to fetch dynamically imported module」で落ちる。
`vite.config.js` の `optimizeDeps.exclude` に Babylon 3 パッケージを入れてある。

## 決定性 (キャプチャの bit-identical)

このプロジェクトの中核資産は「キャプチャが bit-identical であること」で、それにより
`tools/imagediff.mjs` が exit code による決定的な pixel gate として機能する。

守るべきこと:

1. **物理は固定ステップ**。`HavokPlugin(useDeltaForWorldStep=false)` +
   `engine.setTimeStep(0)` で自動ステップを止め、`fixedUpdate` から 1/120 s で
   `_step()` を呼ぶ。Babylon 既定は `scene.render()` 内で実フレーム時間を使うため、
   そのままではフレームレートが変わるだけで結果が変わる。
2. **時間は `ctx.time.elapsed`**。`performance.now()` を使うと、boot 時間が変わるだけで
   位相が変わる (README に記録された事故と同じ構図)。fx のパーティクルもこれを使う。
3. **乱数は `ctx.rng`**。Hard rule 4。
4. **キャプチャは `?backend=webgpu` を明示**。バックエンドが混ざったベースラインは
   「最適化で絵が変わった」という誤診を生む。`tools/capture.mjs` は常に付ける。
5. `csm.autoCalcDepthBounds` は `config.deterministic` のとき切る (カメラが動くたびに
   カスケードの分割位置が変わるため)。`pipe.grain.animated` も同様。

6. **バックエンドのフォールバックはキャンバスを作り直す**。`getContext()` は最初に
   成功した type でキャンバスを固定するため、WebGPU の initAsync が失敗した後に
   同じキャンバスで WebGL2 を作ろうとしても失敗する。`replaceCanvas()` がこれを扱うが、
   **この経路は実機で再現させて検証できていない**。

**既知のトレードオフ**: Havok はクロスプラットフォームでの bit-identical を保証しない
(浮動小数の丸めが CPU 命令セットに依存しうる)。同一マシンでの run-to-run 再現性は
上記で担保できるが、CI のマシンを変えたらベースラインは撮り直しが必要。Three 版は
全演算が JS だったぶん移植性が高かった — 移行による明確な劣化として記録する。

なお **同一マシンでの物理の決定性は 11 ショットの pixel gate が間接的に検証している**
(プレイヤーのキャラクタコントローラが毎フレーム Havok を叩いた状態で 9/11 が
bit-identical)。ラグドールや多数の剛体が写り込むショットを足す場合は、物理単体の
決定性プローブを別途用意した方が安全。

## 品質バー

Every visual subsystem is reviewed by an adversarial critic against real CoD
frames. Non-negotiables:

- **No flat/untextured surfaces.** Every material needs albedo variation, a
  normal map, roughness variation, and a detail layer visible at 0.5 m.
- **No uniform lighting.** Contact shadows, bounce, ambient occlusion, and a
  clear key/fill/rim separation.
- **Physically plausible values.** Albedo in 0.02–0.9, metals are 0 or 1,
  real-world light intensities, **exposure-driven not multiplier-driven**.
  露出の窓口は `render.setExposureBias()` ただ 1 つ。マテリアルの色で明るさを
  合わせ始めた時点で、Three 版の武器 albedo 事故と同じ道に入る。
- **Nothing perfectly straight, clean, or repeated.** Edge wear, grime in
  crevices, subtle warp, varied instance rotation/scale.
- **Every action has weight.** Recoil, camera shake, screen-space impulse,
  audio transient, and a visual FX on every impact.

## 移植で「資産」として持ち込めたもの

描画ライブラリに依存していなかったため、**書き換えずに再利用できた**もの:

| ファイル | 行数 | 中身 |
|---|---|---|
| `src/audio/*` | 4,241 | Web Audio による音響合成一式 |
| `src/fx/{impacts,muzzle,explosions,tracers,util}.js` | 2,051 | surface 別の着弾レシピ |
| `src/weapons/{defs,mathx,clips}.js` + `models/*` | 2,196 | 実銃の寸法と弾道データ |
| `src/world/{layout,palette}.js` | 842 | 街のレイアウトと配色 |
| `src/player/{tuning,springs}.js` | 478 | MW/MWII 実測の操作感パラメータ |
| `src/ui/*` (大半) | ~2,000 | DOM/CSS の HUD |
| `src/physics/surfaces.js` | 143 | 12 種の surface 語彙と LAYER/MASK |

**新しいコードを書く前に、まず `grep -l "from 'three'"` で「そもそも移植が要るか」を
確かめること。** この移植で最も効いた判断がこれだった。
