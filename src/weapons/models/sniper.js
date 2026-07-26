import { Assembly, box, tubeZ, rodZ } from '../geometry.js';
import {
  addBarrel,
  addMuzzleDevice,
  addRail,
  addPistolGrip,
  buildOptic,
} from '../parts.js';

/**
 * Procedural Sniper Rifle (Intervention / .408 CheyTac style heavy precision rifle).
 */
export function buildSniper() {
  const bore = 0.082;
  const zRecRear = 0.10;
  const zRecFront = -0.18;
  const zMuzzle = -0.85;

  const body = new Assembly('sniper-body');

  // Solid Steel Chassis
  const receiver = box(0.042, 0.065, zRecRear - zRecFront, 0.003, 1);
  body.add(receiver, 'steel', { y: bore - 0.012, z: (zRecRear + zRecFront) / 2 });
  receiver.dispose();

  // Scope Rail
  addRail(body, 'steel', zRecFront - 0.02, zRecRear, bore + 0.025);

  // Heavy Bull Barrel & Muzzle Brake
  addBarrel(body, 'steel', zRecFront, zMuzzle, bore, 0.015);
  addMuzzleDevice(body, 'brake', zMuzzle, bore, 0.015);

  // Bipod
  const legL = rodZ(0.004, 0.22, 8);
  body.add(legL, 'steel', { x: -0.025, y: bore - 0.10, z: zRecFront - 0.35, rx: 0.4 });
  legL.dispose();
  const legR = rodZ(0.004, 0.22, 8);
  body.add(legR, 'steel', { x: 0.025, y: bore - 0.10, z: zRecFront - 0.35, rx: 0.4 });
  legR.dispose();

  // High-Power Sniper Scope
  const optic = buildOptic('scope');
  body.add(optic, 'alu', { y: bore + 0.055, z: -0.04 });
  optic.dispose();

  // Adjustable Precision Stock
  const stock = box(0.038, 0.11, 0.28, 0.003, 1);
  body.add(stock, 'poly', { y: bore - 0.03, z: zRecRear + 0.14 });
  stock.dispose();

  addPistolGrip(body, 'poly', bore - 0.03, zRecRear - 0.03);

  // Heavy Detachable Magazine
  const mag = new Assembly('sniper-mag');
  const magMesh = box(0.032, 0.14, 0.12, 0.003, 1);
  mag.add(magMesh, 'steel', { y: -0.06, z: 0 });
  magMesh.dispose();

  return {
    id: 'sniper',
    parts: {
      body: body.build(),
      magazine: mag.build(),
    },
    muzzleZ: zMuzzle - 0.06,
    ejectZ: -0.02,
    magLen: 0.20,
    tris: 1600,
  };
}
