// Types shared by the three plans (plan 01, sections 5.4 and 11). Types only: nothing imports this at run time,
// and there is no build step. JavaScript modules reference these through JSDoc, e.g.
//   /** @type {import('./contracts').SimClock} */
// Phase 0 creates the file from the plan's declarations; each later task fills in the implementation behind one
// of them and corrects the declaration here if the implementation shows it has to change.
import type { Vector3, Matrix3, Matrix4, Color, Texture, Object3D, Scene, PerspectiveCamera, Camera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Placeholders until the renderer migration (phase 2) brings three/webgpu and TSL types in.
export type Node = unknown;
export type NodeMaterial = unknown;
export type WebGPURenderer = unknown;
export type HeightField = unknown;
export type CityConfig = Record<string, unknown>;
export type Settings = Record<string, unknown>;
export type TallEntry = { data: Record<string, unknown>; mesh: Object3D; marker: Object3D; offset: Vector3 };
export type Emitter<Events> = { on<K extends keyof Events>(type: K, fn: (e: Events[K]) => void): () => void; emit<K extends keyof Events>(type: K, e: Events[K]): void };
export type FrameInfo = { nowMs: number; dtWallMs: number; simMs: number; dtSimMs: number; frame: number };
export type QualityProfile = Record<string, unknown>;
export type ModeRegistry = unknown;
export type FrameLoop = { invalidate(): void; settle(): Promise<void> };
/** UTC ms of each event in [dayStartMs, dayStartMs + 24 h), or null when it does not happen that day (src/sky/ephemeris.js). */
export type DayEvents = { astronomicalDawn: number | null; nauticalDawn: number | null; civilDawn: number | null; sunrise: number | null;
  noon: number | null; sunset: number | null; civilDusk: number | null; nauticalDusk: number | null; astronomicalDusk: number | null;
  moonrise: number | null; moonset: number | null };
export type AtmosphereUniforms = Record<string, unknown>;
export type OverrideKey = string;
export type WeatherSample = Record<string, unknown>;

// ---- section 5.4: internal interfaces
// src/app/context.js
export interface AppContext {
  cityId: string; city: CityConfig;
  renderer: WebGPURenderer; scene: Scene; camera: PerspectiveCamera; controls: OrbitControls;
  events: Emitter<AppEvents>; settings: Settings;
  clock: SimClock; timeline: Timeline; env: Environment; quality: Quality; loop: FrameLoop; modes: ModeRegistry;
}
export interface AppEvents {
  'buildings:changed': { hidden: ReadonlySet<string>; moved: ReadonlyMap<string, { dx: number; dz: number }> }; // emitted by interaction/edits.js
  'buildings:rebuilt': { tall: TallEntry[] };            // height cutoff changed (rebuild(), main.js:850)
  'settings:changed': { key: string; value: unknown };
  'mode:changed': { from: string; to: string };
}

// every subsystem in sky/, weather/ and render/ implements this
export type Demand = 'idle' | 'ambient' | 'animated' | 'continuous';
export interface Subsystem {
  init(ctx: AppContext): void | Promise<void>;
  update(f: FrameInfo): void;          // CPU work for this frame; set uniforms; flag LUTs dirty
  demand(): Demand;                    // vote for the next frame (section 5.5)
  setQuality(p: QualityProfile): void;
  dispose(): void;
}

// src/sky/ephemeris.js  (pure, no three.js; unit-tested against JPL Horizons)
export declare function createEphemeris(observer: { lat: number; lon: number; elevationM: number }): {
  at(timeMs: number): CelestialState;                          // memoised to 1 s of simulation time
  events(dayStartMs: number): DayEvents;                       // sunrise, sunset, twilights, moonrise, moonset for the scrubber
  eqjToScene(timeMs: number): Matrix3;                         // J2000 equatorial -> scene axes, for stars and the Milky Way
  timeOfSunAltitude(altDeg: number, dayMs: number, which: 'rising' | 'setting'): number | null;   // what env.ephemeris exposes
  readonly observer: { lat: number; lon: number; elevationM: number };
};
export interface BodyState { dir: Vector3; azDeg: number; altDeg: number; trueAltDeg: number; distanceM: number; angularRadiusRad: number; magnitude: number }
export interface CelestialState {
  sun: BodyState & { eclipsedFraction: number };
  moon: BodyState & { phaseFraction: number; phaseAngleDeg: number; libration: { lonDeg: number; latDeg: number };
                      orientation: Matrix3 /* moon-fixed -> scene */; umbra: number /* 0..1 during a lunar eclipse */ };
  planets: Record<'mercury' | 'venus' | 'mars' | 'jupiter' | 'saturn', BodyState>;
}

// src/sky/atmosphere/index.js
export declare function createAtmosphere(ctx: AppContext): Subsystem & {
  uniforms: AtmosphereUniforms;                                // every medium parameter is a uniform (section 7.4)
  luts: { transmittance: Texture; multiScatter: Texture; skyView: Texture; skyViewCloudy: Texture; froxels: Texture };
  nodes: {
    sky(dirWorld: Node): Node;                                 // vec3 luminance toward infinity
    aerialPerspective(posWorld: Node): Node;                   // vec4: rgb in-scattered luminance, a transmittance
    transmittanceToLight(posWorld: Node, lightDir: Node): Node;
    composite(color: Node, depth: Node): Node;                 // the post node
  };
  cpu: { lightAt(altitudeM: number, lightDir: Vector3, e0Lux: number): { illuminanceLux: number; color: Color } };
};

// src/sky/lightRegistry.js  (section 7.8)
export type Distribution = 'garstang' | 'facade' | 'upward' | 'beam';
export interface Emitter {
  id: string; buildingId?: string;                             // buildingId links the emitter to hide and move
  position: [number, number, number];                          // world metres
  intensityCd: number;                                         // peak luminous intensity
  distribution: Distribution; color?: [number, number, number];
  inSatellite: boolean;                                        // true: subtracted from the VIIRS base so it is not counted twice
}
export interface LightRegistry {
  register(e: Emitter | Emitter[]): () => void;
  setBuildingState(buildingId: string, s: { visible: boolean; dx: number; dz: number }): void;
  readonly version: number;                                    // bumps on any change; sky glow recomputes when it moves
  totals(): { lumens: number; byBuilding: Map<string, number> };
}

// src/sky/skyglow.js
export declare function createSkyglow(ctx: AppContext): Subsystem & {
  fluence: Texture;                                            // rgb: flux vector, a: scalar fluence (lux at cityFactor = 1)
  cpu: { luminance(posWorld: Vector3, dir: Vector3): number;   // cd/m2, artificial part only
         zenith(posWorld: Vector3): { cdM2: number; magArcsec2: number } };
};

// src/weather/service.js
export interface WeatherService extends Subsystem {
  setSource(s: { kind: 'live' } | { kind: 'history' } | { kind: 'preset'; id: string }): void;
  setOverride(key: OverrideKey, value: number | null): void;   // null = follow data
  sample(timeMs: number): WeatherSample;                       // interpolated, overrides applied (section 6.4)
  readonly status: { kind: string; observedAtMs: number | null; station: string | null; stale: boolean; attribution: string[] };
}

// src/render/pipeline.js
export type StageAt = 'beforeScene' | 'afterScene' | 'afterWorld' | 'beforeBloom' | 'afterAA' | 'afterBloom' | 'overlay';
export interface Pipeline {
  render(): void;
  setCamera(camera: Camera): void;      // the active view; shadows, atmosphere and exposure follow it
  addStage(s: { id: string; at: StageAt;
                render?: (renderer: WebGPURenderer, f: FrameInfo) => void;      // draw into your own targets, or run a pass of your own
                node?: (input: { color: Node; depth: Node; bloom: Node }) => Node }): () => void;
  readonly sceneColor: Node;  readonly sceneDepth: Node;  readonly bloom: Node;
  probe(ndcX: number, ndcY: number): Promise<{ luminanceCdM2: number; rgb: [number, number, number] }>;  // scene-referred, before exposure
}

// ---- section 11: the public contracts
export interface SimClock {
  readonly timeMs: number;      // UTC epoch milliseconds. The only time base in the app.
  readonly rate: number;        // simulation seconds per wall second. 1 = real time. May be negative.
  readonly playing: boolean;
  readonly live: boolean;       // following the wall clock
  readonly zone: string;        // IANA zone of the city, from cities.json `tz` ('America/Los_Angeles')
  set(timeMs: number): void;    // jump; leaves live mode; emits 'seek'
  setLocal(p: { year: number; month: number; day: number; hour: number; minute: number; second?: number }): void;
  setTimeOfDay(hour: number, minute?: number): void;       // keeps the local date
  play(): void;  pause(): void;  setRate(rate: number): void;  goLive(): void;
  local(timeMs?: number): { year: number; month: number; day: number; hour: number; minute: number; second: number;
                            weekday: number; zoneAbbr: string; offsetMin: number };
  format(timeMs?: number, style?: 'time' | 'date' | 'full'): string;
  on(type: 'tick' | 'seek' | 'rate' | 'state', fn: (e: { clock: SimClock; simMs: number; dtSimMs: number }) => void): () => void;
  step(dtSimMs: number): void;  // tests: advance by an exact amount with no wall clock involved
}

export interface Journey {
  id: string;  label: string;
  durationS: number;                    // seconds of real travel along the path
  recordedStartMs?: number;             // the real start of a recorded track (ADS-B); absent for a computed drive
  markers?: { progressS: number; label: string }[];
  onProgress?(progressS: number, info: { seek: boolean; dtS: number }): void;  // place the camera and the vehicle here, or read the clock yourself
  rebase?(startMs: number): void;       // called when the departure moves, for a journey that keeps its own time mapping
  atEnd?: 'pause' | 'hold' | 'loop';    // default 'pause'
}
export interface JourneyHandle {
  readonly progressS: number;  readonly startMs: number;
  seek(progressS: number): void;        // clock.set(startMs + progressS * 1000)
  setStart(startMs: number): void;      // keep the position on the path, move the sky
  setTimeOfDay(hour: number, minute?: number): void;   // setStart so that the present moment has that local time
  useRecordedStart(): void;
  end(): void;
}
export interface Timeline {
  begin(j: Journey, o?: { startMs?: number; coupling?: 'clock' | 'frozen-sky' }): JourneyHandle;
  readonly active: JourneyHandle | null;
  on(type: 'begin' | 'end', fn: (h: JourneyHandle) => void): () => void;
}
export interface Transport {
  attachJourney(j: Journey | null): JourneyHandle | null;   // the same as timeline.begin(j) and handle.end()
  readonly slotAbove: HTMLElement;      // where a mode mounts its own bar, directly above the transport
}

export interface Environment {
  readonly state: EnvState;             // rebuilt at frame step 40; treat as read-only
  readonly nodes: EnvNodes;             // 11.5
  readonly lights: LightRegistry;       // section 5.4; register emitters so they feed sky glow and obey hide, move and lights-out
  readonly nightlights: NightLights;    // 11.7
  readonly ephemeris: { at(timeMs: number): CelestialState;             // any instant, not only now
                        timeOfSunAltitude(altDeg: number, dayMs: number, which: 'rising' | 'setting'): number | null };
  readonly exposure: { setMeteringMask(mask: Texture | null): void };   // meter through the windscreen, not the dashboard
  at(posWorld: Vector3): LocalEnv;      // CPU query anywhere in the world, valid after step 40
  lightAt(posWorld: Vector3): { sunLux: number; sunColor: Color; moonLux: number; moonColor: Color; ambientLux: number };
  lightning: { strikesBetween(t0Ms: number, t1Ms: number): Strike[];        // deterministic; safe to call ahead of time
               on(type: 'strike', fn: (s: Strike) => void): () => void };
  precipitation: { setShelter(v: { matrixWorld: Matrix4; halfSize: Vector3 } | null): void;   // no rain drawn inside this box (car, cabin)
                   setIlluminators(spots: { position: Vector3; direction: Vector3; coneDeg: number; candela: number; color: Color }[]): void };  // up to 4; lights rain in headlights
  freeze(o: { time?: string | number; weather?: string | WeatherSample; seed?: number; ev100?: number;
              lights?: number; sunAzAlt?: [number, number] }): void;       // pin anything for tests and screenshots
  unfreeze(): void;
  on(type: 'weather' | 'lights' | 'quality', fn: () => void): () => void;
}

export interface EnvState {
  timeMs: number;  seed: number;
  sun: LightBody;
  moon: LightBody & { phaseFraction: number };
  key: { body: 'sun' | 'moon' | 'none'; dir: Vector3; illuminanceLux: number; color: Color };   // the light that casts shadows
  sky: { ambientLux: number; horizontalLux: number; zenithCdM2: number; magArcsec2: number; bortle: number; limitingMag: number;
         phase: 'day' | 'civil' | 'nautical' | 'astronomical' | 'night' };
  exposure: { ev100: number; scale: number };   // scale converts cd/m2 to HDR-buffer units
  lights: { cityFactor: number;                 // the lights-out slider, 0..1
            windows: number; street: number; signs: number };   // 0..1 switch-on state from dusk and hour of night
  weather: WeatherSample;                       // section 6.4; interpolated, overrides applied
  wind: Vector3;                                // m/s at 10 m, world axes
  visibilityM: number;                          // meteorological range at the camera
  rain: { rateMmH: number; fallSpeedMs: number; streakM: number };   // at the camera
  wetness: { film: number; puddles: number };   // 0..1 at the camera
  lightning: { flash: number; last: Strike | null };                 // flash = current 0..1 envelope of the brightest active flash
}
export interface LightBody { dir: Vector3; azDeg: number; altDeg: number; illuminanceLux: number; color: Color;
                      angularRadiusRad: number; aboveHorizon: boolean }
export interface LocalEnv { rainRateMmH: number; wetness: { film: number; puddles: number }; cloudDensity: number; inCloud: boolean;
                     dustExtinctionPerM: number; visibilityM: number; artificialLux: number;
                     tempC: number; wind: Vector3 }   // air temperature and wind at that position's height, not at 10 m
export interface Strike { timeMs: number; position: Vector3; kind: 'cloud-ground' | 'in-cloud'; peakCandela: number;
                   strokeOffsetsMs: number[] }

export interface EnvNodes {
  exposure: Node;                                       // float
  cityFactor: Node;                                     // float, the lights-out slider
  switchOn: { windows: Node; street: Node; signs: Node };
  emissive(cdM2: Node | number, o?: { artificial?: boolean }): Node;      // cd/m2 -> HDR units; x cityFactor when artificial
  pointSource(candela: Node | number, o?: { artificial?: boolean; minPixels?: number }): { color: Node; sizePx: Node };
  keyLightDir: Node;
  keyLight(posWorld: Node): Node;                       // vec3 illuminance x colour at that point; terrain and cloud shadow included
  ambient(normalWorld: Node, posWorld?: Node): Node;    // vec3 irradiance: sky (natural and artificial) plus ground bounce
  skyReflection(dirWorld: Node, roughness?: Node): Node;   // vec3 luminance of sky and clouds, for glass, paint and water
  artificialLight(posWorld: Node): Node;                // vec3 lux arriving from the city (lights an aircraft belly, a cabin ceiling)
  aerialPerspective(posWorld: Node): Node;              // vec4: rgb in-scattered luminance, a transmittance
  transmittance(posWorld: Node): Node;                  // vec3 from the camera to that point; for sprites, which have no depth
  cloudShadow(posWorld: Node): Node;                    // float 0..1
  wetness(posWorld: Node): Node;                        // vec2: film, puddles
  wetLayer(s: SurfaceNodes, o?: { porosity?: Node; puddleMask?: Node }): SurfaceNodes;
  applyWetSurface(material: NodeMaterial, o: { porosity: number; puddleMask?: Node }): void;   // wetLayer() wired into a standard node material
}
export interface SurfaceNodes { albedo: Node; roughness: Node; normal: Node; f0: Node }

export interface Shadows {
  readonly castsFrom: 'sun' | 'moon' | 'none';
  addLocalCascade(target: Object3D, o: { radiusM: number; mapSize?: number }): () => void;
  registerHeightField(hf: HeightField): () => void;     // extra terrain (the drive corridor, the flight region) joins the far terrain shadow
}

export interface NightLights {
  radiance(x: number, z: number): number;        // nW cm-2 sr-1; the satellite's annual near-nadir composite
  baseRadiance(x: number, z: number): number;    // the same with registered `inSatellite` emitters removed
  upwardLuminance(x: number, z: number): number; // cd/m2 toward the zenith, area-averaged: baseRadiance / k
  groundEmission(x: number, z: number): number;  // lm per m2 of ground (Garstang inversion)
  readonly texture: Texture;  toUV(posWorld: Node): Node;   // for shaders
  setDrawnMask(mask: Texture | null): void;      // where a plan draws real lamps, the terrain's own emission is suppressed
  setLampCells(cells: LampCells | null): void;   // street-lamp lumens per cell by class; splits the base (section 7.8)
}
export interface LampCells { x0: number; z0: number; step: number; nx: number; nz: number;
                      sodiumLm: Float32Array; ledLm: Float32Array; otherLm: Float32Array }

export interface Quality {
  readonly level: 'low' | 'high' | 'ultra';
  readonly backend: 'webgpu' | 'webgl2';
  readonly profile: QualityProfile;              // section 7.14; other plans read it to scale their own detail
  readonly caps: { webgpu: boolean; compute: boolean; reversedDepth: boolean; floatTargets: boolean; maxTextureSize: number };
  readonly renderScale: number;                  // current dynamic resolution, 0.6 to 1.0
  readonly budgetMs: { frame: number; environment: number; weather: number; city: number; modes: number };   // section 9.1
  set(level: 'auto' | 'low' | 'high' | 'ultra'): void;
  on(type: 'change', fn: (q: Quality) => void): () => void;
}
