// Writes synthetic-19.json and synthetic-19.bin beside this file: the last 10 minutes of the synthetic runway 19R
// arrival at Las Vegas (tests/helpers/flightTrack.js), in the baked format, for developing the flight before a real
// track is baked. Run from the repository root: node tests/fixtures/flight/make_synthetic.mjs
// tests/unit/flight/track.test.js checks that the committed files still match the generator.
import { writeFileSync } from 'node:fs';
import { syntheticArrival } from '../../helpers/flightTrack.js';

const { header, buffer } = syntheticArrival({ durationS: 600 });
const here = new URL('.', import.meta.url);
writeFileSync(new URL('synthetic-19.json', here), `${JSON.stringify(header, null, 2)}\n`);
writeFileSync(new URL('synthetic-19.bin', here), Buffer.from(buffer));
console.log(`synthetic-19: ${header.samples} samples x ${header.channels.length} channels, ${buffer.byteLength} bytes, events ${header.events.map((e) => e.id).join(' ')}`);
