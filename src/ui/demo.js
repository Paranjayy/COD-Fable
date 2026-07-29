import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

/**
 * カメラのローカル軸。scene.useRightHandedSystem = true なので前方は -Z。
 * getDirectionToRef はカメラのワールド行列を使うので、FreeCamera が
 * rotationQuaternion ではなく Euler の rotation で駆動されていても正しく動く
 * (player/camera.js は rotation を書いている)。
 */
const FORWARD_LOCAL = new Vector3(0, 0, -1);
const RIGHT_LOCAL = new Vector3(1, 0, 0);

/**
 * Scripted mid-combat HUD state for `debugState('combat')`.
 *
 * The capture harness applies a shot and then pumps a fixed number of frames,
 * so the timeline is keyed on *frame index*, not wall clock: the window around
 * frame 90 (where the screenshot lands) is deliberately the busiest moment —
 * a fresh headshot hitmarker, two decaying damage arcs at different ages,
 * three damage numbers mid-flight, a live grenade warning, an elimination
 * banner and a killfeed with staggered row ages.
 *
 * It then loops on a 240 frame cycle so the HUD also looks alive when a human
 * is watching it in the browser.
 */
const CYCLE = 240;

export class CombatDemo {
  constructor() {
    this.active = false;
    this.frame = 0;
    this._p = new Vector3();
    this._q = new Vector3();
  }

  start(ui) {
    this.active = true;
    this.frame = 0;

    const s = ui.state;
    s.health = 62;
    s.maxHealth = 100;
    s.armour = 78;
    s.maxArmour = 150;
    s.regen = false;
    s.ammo = 26;
    s.reserve = 94;
    s.magSize = 30;
    s.reloading = false;
    s.reloadProgress = 0;
    s.weaponName = 'M4A1';
    s.fireMode = 'AUTO';
    s.lethalCount = 2;
    s.tacticalCount = 1;
    s.move = 0.34;
    s.sprint = false;
    s.crouch = false;
    s.ads = false;
    s.scoreUs = 43;
    s.scoreThem = 38;
    s.timeLeft = 247;
    s.mode = 'TDM';
    s.simulate = true;

    ui.health.hurt = 0.13; // start already bloodied rather than fading in
    ui.killfeed.clear();
    ui.arcs.clear();
    ui.hit.clear();
    ui.markers.clear();

    // Killfeed seeded with three rows at different ages so the column shows the
    // full fade ramp instead of three identical rows.
    const seed = [
      { attacker: 'VOSS', victim: 'M. RIDLEY', headshot: false, age: 3.2 },
      { attacker: 'KRAUSE', victim: 'HOLT', headshot: true, age: 1.9, attackerFriendly: false },
      { attacker: 'YOU', victim: 'A. SOKOL', headshot: false, age: 0.55, mine: true },
    ];
    for (const e of seed) {
      const it = ui.killfeed.push(e);
      it.t = e.age;
    }

    ui.setObjectives([
      { position: new Vector3(-6.5, 1.4, -2.5), label: 'A', name: 'PLANT' },
      { position: new Vector3(15.5, 1.4, -11), label: 'B', name: 'HOLD' },
      { position: new Vector3(-19, 1.4, 25), label: 'C', name: 'EXFIL' },
    ]);

    // Enemy / friendly contacts around the player for the minimap.
    ui.setBlips([
      { x: -2, z: 4, kind: 'enemy', heading: 200 },
      { x: 6.5, z: -8, kind: 'enemy', heading: 145 },
      { x: 18, z: 6, kind: 'enemy', heading: 300 },
      { x: 21, z: 26, kind: 'friend', heading: 20 },
      { x: 8, z: 22, kind: 'friend', heading: 340 },
    ]);

    ui.setPrompt({ key: 'F', text: 'Pick up ammo', sub: 'hold', progress: 0.42 });
  }

  stop(ui) {
    this.active = false;
    ui.state.simulate = false;
    ui.clearPrompt();
  }

  /**
   * カメラの前方 `forward` m、右に `side` m の点。高さはカメラ基準で `up` m。
   *
   * 返すのは共有スクラッチ (`this._p`)。呼び出し側は次の _worldPoint() まで
   * しか保持できない — markers 側は受け取った直後に copyFromFloats で自分の
   * 領域へ写しているので問題ない。
   *
   * add() ではなく addInPlace() を使うのは毎フレームのアロケーション禁止
   * (ARCHITECTURE Hard rule 5) のため。Babylon の add() は新しい Vector3 を返す。
   */
  _worldPoint(ui, forward, side, up) {
    const cam = ui.ctx.camera;
    const eye = cam.globalPosition;
    cam.getDirectionToRef(FORWARD_LOCAL, this._p);
    this._p.scaleInPlace(forward);
    cam.getDirectionToRef(RIGHT_LOCAL, this._q);
    this._q.scaleInPlace(side);
    this._p.addInPlace(this._q).addInPlace(eye);
    this._p.y = eye.y + up;
    return this._p;
  }

  _fire(ui) {
    const s = ui.state;
    ui.crosshair.onFire(1);
    if (s.ammo > 0) s.ammo--;
    ui.sfx('weapon_fire_dry', 0.25);
  }

  update(ui, dt) {
    if (!this.active) return;
    const f = this.frame++ % CYCLE;
    const s = ui.state;

    // continuous walk bob on the reticle
    s.move = 0.3 + 0.14 * Math.sin(this.frame * 0.035);
    s.timeLeft = Math.max(0, 247 - this.frame / 60);

    switch (f) {
      case 20:
        ui.arcs.spawn(-0.72, 0.69, 0.8); // behind-left
        break;
      case 40:
        ui.banner.show('Enemy Eliminated', '+100 XP');
        break;
      case 50:
        ui.markers.spawnGrenade(this._worldPoint(ui, 9, -3.4, -1.3), 2.6);
        ui.sfx('grenade_warn', 0.5);
        break;
      case 58:
        ui.arcs.spawn(0.62, -0.78, 1.0); // ahead-right
        ui.hurt(11, 0.62, -0.78);
        break;
      case 100:
        ui.killfeed.push({ attacker: 'YOU', victim: 'D. KOVACS', headshot: true, mine: true });
        break;
      case 128:
        ui.hitmarker('kill');
        ui.banner.show('Enemy Eliminated', '+100 XP');
        ui.damageNumber(this._worldPoint(ui, 13, 1.1, 0.2), 118, 'kill');
        break;
      case 150:
        s.reloading = true;
        s.reloadProgress = 0;
        break;
      case 214:
        ui.arcs.spawn(-0.2, 0.98, 0.9);
        ui.hurt(9, -0.2, 0.98);
        break;
      default:
        break;
    }

    // burst fire pattern: three bursts of four, ~510 rpm
    if (f >= 30 && f <= 107 && (f - 30) % 7 === 0 && !s.reloading) {
      const shot = (f - 30) / 7;
      if (shot !== 4 && shot !== 5) {
        this._fire(ui);
        if (shot === 2) {
          ui.hitmarker('hit');
          ui.damageNumber(this._worldPoint(ui, 12.5, 2.4, 0.35), 33, 'hit');
        } else if (shot === 7) {
          ui.hitmarker('armour');
          ui.damageNumber(this._worldPoint(ui, 12.8, -2.6, 0.05), 18, 'armour');
        } else if (shot === 8) {
          // the frame-86 headshot — this is what the critic shot lands on
          ui.hitmarker('head');
          ui.damageNumber(this._worldPoint(ui, 12.2, 0.25, 0.8), 74, 'hs');
        }
      }
    }

    if (s.reloading) {
      s.reloadProgress = Math.min(1, s.reloadProgress + dt / 2.1);
      if (s.reloadProgress >= 1) {
        s.reloading = false;
        const need = s.magSize - s.ammo;
        const take = Math.min(need, s.reserve);
        s.ammo += take;
        s.reserve -= take;
      }
    }

    // slow health regeneration between hits, CoD style
    if (!s.reloading && s.health < s.maxHealth && f > 214) {
      s.regen = true;
      s.health = Math.min(s.maxHealth, s.health + dt * 9);
    }
    if (f === 239) {
      s.health = 62;
      s.regen = false;
      s.ammo = 26;
      s.reserve = 94;
    }
  }
}
