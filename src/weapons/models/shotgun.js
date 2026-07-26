import { Assembly, box, latheZ, tubeZ, rodZ } from '../geometry.js';
import {
  addBarrel,
  addRail,
  addPistolGrip,
  addFrontSight,
  addRearSight,
  addScrew,
} from '../parts.js';

/**
 * Procedural Shotgun (M870 / M4 Super 90 style 12-gauge).
 */
export function buildShotgun() {
  const bore = 0.072;
  const zRecRear = 0.08;
  const zRecFront = -0.14;
  const zMuzzle = -0.62;

  const body = new Assembly('shotgun-body');

  // Main Receiver Box
  const receiver = box(0.038, 0.058, zRecRear - zRecFront, 0.002, 1);
  body.add(receiver, 'alu', { y: bore - 0.01, z: (zRecRear + zRecFront) / 2 });
  receiver.dispose();

  // Top Rail
  addRail(body, 'alu', zRecFront + 0.01, zRecRear - 0.01, bore + 0.022);

  // Heavy 12-gauge Barrel & Under-barrel Tube Magazine
  addBarrel(body, 'steel', zRecFront, zMuzzle, bore, 0.012);
  const magTube = tubeZ(0.011, 0.009, Math.abs(zMuzzle - zRecFront) * 0.9, 16);
  body.add(magTube, 'steel', { y: bore - 0.022, z: (zRecFront + zMuzzle) / 2 });
  magTube.dispose();

  // Pump / Handguard
  const pump = tubeZ(0.022, 0.014, 0.18, 16);
  body.add(pump, 'poly', { y: bore - 0.022, z: -0.32 });
  pump.dispose();

  // Stock
  const stock = box(0.032, 0.09, 0.22, 0.003, 1);
  body.add(stock, 'poly', { y: bore - 0.04, z: zRecRear + 0.11, rx: 0.08 });
  stock.dispose();

  addPistolGrip(body, 'poly', bore - 0.025, zRecRear - 0.02);
  addFrontSight(body, 'steel', zMuzzle + 0.02, bore + 0.012);
  addRearSight(body, 'steel', zRecRear - 0.03, bore + 0.022);

  // Magazine Mesh (12g shell tube)
  const mag = new Assembly('shotgun-mag');
  const magMesh = box(0.028, 0.045, 0.12, 0.002, 1);
  mag.add(magMesh, 'poly', { y: -0.02, z: 0 });
  magMesh.dispose();

  return {
    id: 'shotgun',
    parts: {
      body: body.build(),
      magazine: mag.build(),
    },
    muzzleZ: zMuzzle,
    ejectZ: -0.05,
    magLen: 0.14,
    tris: 1200,
  };
}
