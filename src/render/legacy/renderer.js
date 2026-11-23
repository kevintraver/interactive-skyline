// The classic WebGLRenderer, kept behind ?renderer=legacy until phase 3 (plan 01, T2.1, R1): the phase 1 renderer
// with its GLSL materials, so the new renderer can be compared with it in the same run (the parity specs and
// pnpm test:perf:ab). A separate chunk: a default visitor never downloads it.
import { WebGLRenderer } from 'three';
import { active } from '../active.js';
import * as materials from './materials.js';

export async function createLegacyRenderer({ canvas }) {
  active.legacy = materials;
  return new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
}
