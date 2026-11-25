// The window panel (plan 03, F5.7): what each switch does to the pane. The DOM half is driven by the flight specs
// (tests/e2e/flight/window.gpu.spec.js).
import { describe, it, expect } from 'vitest';
import { paneSettings, WINDOW_SWITCHES, WINDOW_DEFAULTS } from '../../../src/flight/ui/windowPanel.js';

describe('paneSettings()', () => {
  it('every effect on and focused far by default', () => {
    expect(paneSettings({})).toEqual({ enabled: true, focus: 'far',
      effects: { frost: true, condensation: true, droplets: true, scratches: true, reflections: true } });
  });
  it('each switch drives its own effects and nothing else', () => {
    for (const sw of WINDOW_SWITCHES.filter((s) => s.effects)) {
      const p = paneSettings({ [sw.id]: false });
      for (const [k, v] of Object.entries(p.effects)) expect(v).toBe(!sw.effects.includes(k));
      expect(p.enabled).toBe(true);
    }
  });
  it('glass off disables the pane; focus follows the switch', () => {
    expect(paneSettings({ glass: false }).enabled).toBe(false);
    expect(paneSettings({ focus: 'pane' }).focus).toBe('pane');
    expect(paneSettings({ focus: 'nonsense' }).focus).toBe('far');
  });
  it('names five switches, glass first', () => {
    expect(WINDOW_SWITCHES.map((s) => s.id)).toEqual(['glass', 'frost', 'rain', 'scratches', 'reflections']);
    expect(Object.keys(WINDOW_DEFAULTS)).toEqual(['glass', 'frost', 'rain', 'scratches', 'reflections', 'focus']);
  });
});
