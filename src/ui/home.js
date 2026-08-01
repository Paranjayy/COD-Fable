import { el, setStyle } from './util.js';

/**
 * First-contact lobby. It deliberately owns no game simulation: choosing a
 * tile only hands a session label to the existing HUD and enables controls.
 * This keeps the launch surface cheap and lets real game modes grow behind the
 * same interface instead of forking player, weapon, or AI code.
 */
export class HomeScreen {
  constructor(parent, { onStart, onSettings, onPerformance }) {
    this.onStart = onStart;
    this.onSettings = onSettings;
    this.onPerformance = onPerformance;
    this.root = el('section', 'ow-home', parent);
    this.root.setAttribute('aria-label', 'COD Fable command lobby');

    const mast = el('div', 'ow-home-mast', this.root);
    el('div', 'ow-home-eyebrow', mast, 'Fable command // build 01');
    el('h1', 'ow-home-title', mast, 'COD FABLE');
    el('p', 'ow-home-deck', mast, 'A procedural combat sandbox. No assets. No excuses.');

    const actions = el('div', 'ow-home-actions', this.root);
    this.operation = this._mode(actions, '01', 'Garrison operation', 'Live-fire patrol · hostile squads · objectives', 'operation');
    this.practice = this._mode(actions, '02', 'Practice range', 'Movement, weapons, and map familiarisation', 'practice');

    const rail = el('div', 'ow-home-rail', this.root);
    const status = el('div', 'ow-home-status', rail);
    el('span', null, status, 'System status');
    el('strong', null, status, 'Online');
    this.performance = el('button', 'ow-home-performance', rail, 'Performance profile · M1 / older Macs');
    this.performance.type = 'button';
    this.performance.addEventListener('click', () => this.onPerformance?.());
    this.settings = el('button', 'ow-home-settings', rail, 'Settings');
    this.settings.type = 'button';
    this.settings.addEventListener('click', () => this.onSettings?.());

    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') e.stopPropagation();
    });
    this.open = true;
  }

  _mode(parent, number, name, detail, mode) {
    const button = el('button', 'ow-home-mode', parent);
    button.type = 'button';
    button.dataset.mode = mode;
    el('span', 'ow-home-index', button, number);
    const copy = el('span', 'ow-home-copy', button);
    el('strong', null, copy, name);
    el('small', null, copy, detail);
    el('span', 'ow-home-go', button, 'Enter');
    button.addEventListener('click', () => this.start(mode));
    return button;
  }

  start(mode) {
    if (!this.open) return;
    this.hide(true);
    this.onStart?.(mode);
  }

  hide(animate = false) {
    this.open = false;
    this.root.classList.toggle('leaving', animate);
    setStyle(this.root, 'pointer-events', 'none');
    if (animate) setTimeout(() => setStyle(this.root, 'display', 'none'), 380);
    else setStyle(this.root, 'display', 'none');
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.root.classList.remove('leaving');
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'pointer-events', 'auto');
    this.operation.focus();
  }

  dispose() {
    this.root.remove();
  }
}
