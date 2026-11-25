// Types of the flight (plan 03, section 5.5). Types only: nothing imports this at run time. JavaScript modules
// reference them through JSDoc, e.g. /** @type {import('./types.d.ts').AircraftState} */
import type { Vector3, Quaternion } from 'three';
import type { Journey } from '../contracts';

/** The aircraft at one moment of a journey. Scene axes: x east, y up, z south. */
export interface AircraftState {
  t: number;                 // seconds from the start of the track (clamped to [0, durationS])
  s: number;                 // metres along the ground track from its start
  position: Vector3;         // main-gear contact point on the centre line, scene axes, metres
  quaternion: Quaternion;    // body -> scene; body axes: nose -Z, right wing +X, up +Y; built on the level frame
  velocity: Vector3;         // m/s over the ground, scene axes (the rate of change of position, curve drop included)
  airVelocity: Vector3;      // m/s through the air: velocity minus the wind of the header's atmosphere profile
  heading: number;           // rad, [0, 2 pi), clockwise from grid north
  pitch: number;             // rad, nose up positive
  roll: number;              // rad, right wing down positive
  altMsl: number;            // m above sea level
  gs: number; tas: number; ias: number; vs: number;   // m/s; vs is the rate of change of altMsl
  flap: number;              // 0..40: surface position in lever units (7.5 = between 5 and 10)
  slat: number;              // 0 retracted, 1 extend, 2 full extend
  gear: number;              // 0 up .. 1 down
  speedbrake: number; groundSpoiler: number; reverser: number;   // 0..1
  lights: number;            // bit field, LIGHT in track.js: NAV 1 | BEACON 2 | STROBE 4 | LANDING 8 | TAXI 16 | TURNOFF 32 | LOGO 64 | WING 128
  cabinLight: number; turbulence: number;                        // 0..1
  onGround: boolean;         // from the touchdown time on
}

export interface FlightEvent { t: number; s: number; id: string; label: string }

/** The <id>.json header of format skyline-flight/1 (section 6.2). */
export interface FlightMeta {
  format: 'skyline-flight/1';
  id: string; city: string; airport: string; runway: string; aircraftType: string;
  label?: string;                          // overrides the title made from the runway and badges.from
  recordedStart: string; touchdown?: string;                     // ISO 8601 UTC
  dt: number; samples: number;
  channels: string[];                      // x n h s gs vs tas ias hdg pitch roll flap slat gear speedbrake groundSpoiler reverser lights cabinLight turbulence
  provenance: Record<string, 'recorded' | 'derived' | 'inferred' | 'reconstructed' | 'synthetic' | string>;
  reconstructed: { from: number; to: number; what: string }[];
  events: { t: number; s?: number; id: string; label: string }[];
  atmosphere: [altM: number, tempC: number, windEastMs: number, windNorthMs: number][];
  badges: {
    light: 'day' | 'dusk' | 'night'; weather: string; from: string; stripSide: 'left' | 'right';
    /** Where the Strip is seen over the last three minutes: beside the aircraft on that side; ahead at first, then along
     * that side and abeam before touchdown (passes-); mostly ahead, seen from that side only looking forward (ahead-);
     * ahead; not at all. Shown on the card (ui/cards.js stripText); a value not listed falls back to stripSide. */
    stripView?: 'right' | 'left' | 'passes-right' | 'passes-left' | 'ahead-right' | 'ahead-left' | 'ahead' | 'none';
  };
  qa: { glidePathDeg: number; crossingHeightM: number; touchdownPastThresholdM: number; altitudeOffsetM: number; datum: string; waived?: unknown[] };
  /** The journey's chapters, each from its event to the next (the journey bar's markers, journey.js chapterMarkers). */
  chapters?: { id: string; label: string; from: number; to: number }[];
  /** What the bake inferred rather than recorded (weight, approach speed, flap selections...). */
  inferred?: Record<string, unknown>;
  source: { archive: string; release?: string; licence: string; [k: string]: string | undefined };
}

/** The header of a generated orbit (orbit.js createOrbitTrack): the flight file's fields, filled for an orbit. */
export interface OrbitMeta extends Omit<FlightMeta, 'format' | 'qa'> {
  format: 'skyline-orbit/1';
  kind: 'orbit';
  qa: Record<string, never>;
  orbit: OrbitParams;
}

/** orbit.js orbitParams: the orbit completed and held inside the limits (section 4.6, 7.12). */
export interface OrbitParams {
  center: { x: number; n: number };        // metres east and north of the city origin
  altFt: number;                           // 4,500 to 41,000 ft above sea level
  radiusKm: number;                        // the bank limit's smallest at this height and speed, to 60 km
  phaseDeg: number;                        // the bearing from the centre where the circle starts, clockwise from north
  seat: string | null; seatSide: 'left' | 'right'; outward: boolean;
  direction: 'cw' | 'ccw'; directionSet: boolean;
  iasKt: number | null;                    // a speed other than the schedule's
  wind: { east: number; north: number };   // m/s toward east and north, one wind for the whole orbit
  rollIn: boolean; turns: number; city: string; sunAltDeg: number; startMs: number; weightKg: number;
  minRadiusKm: number; iasKtFlown: number; tasKt: number; mach: number;   // derived, for the panel
}

export interface Track {
  meta: FlightMeta | OrbitMeta;
  dt: number; samples: number;
  durationS: number; lengthM: number;
  recordedStartMs: number;
  touchdownT: number;                      // seconds from the start; Infinity if the header has no touchdown
  events: FlightEvent[];                   // in time order, with s filled in
  channel(name: string): Float32Array | null;     // as stored (heading in degrees, wrapped)
  sAt(t: number): number;
  timeAtS(s: number): number;              // the inverse of sAt, clamped to [0, durationS]
  sample(t: number, out?: AircraftState): AircraftState;   // Hermite between samples; clamps at both ends
}

/** flightJourney(track, apply): plan 01's Journey plus plan 02's members and the condensed pace. */
export interface FlightJourney extends Journey {
  markers: { progressS: number; label: string; id: string }[];
  atEnd: 'hold';
  track: Track;
  readonly startMs: number;
  rebase(startMs: number): void;
  length: number;                          // metres (plan 02)
  poseAt(simMs: number): AircraftState;    // (plan 02)
  timeAt(s: number): number;               // (plan 02)
  paceRate(progressS: number): number;     // the clock rate to use at this progress for the condensed pace
  paceDurationS(): number;                 // wall seconds of the whole flight at the condensed pace
}

/** orbit.js createOrbitTrack / changeOrbit / planChange: a Track with the orbit's own members. touchdownT is Infinity;
 * the events are rollIn or change, join, lap2, lap3. */
export interface OrbitTrack extends Track {
  meta: OrbitMeta;
  orbit: OrbitParams;
  joinT: number;                           // seconds from the start at which the steady circle begins
  lapS: number;                            // one lap of the steady circle
  bankDeg: number;                         // the steady circle's bank (with a wind, its largest)
  overLimit: boolean;
  phaseAt(t: number): number;              // degrees, the bearing from the centre now
  timeAtPhase(phaseDeg: number): number;
  wrap(t: number): number;                 // a time past the end brought back onto the steady circle by whole laps
  loadFactorAt(t: number): number;
  kinAt(t: number, out?: object): object;
  frame: { sceneY(h: number, x: number, y: number): number };
}
