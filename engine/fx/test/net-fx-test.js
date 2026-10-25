// A network stream through the rack (netStreamOpen with fx), against the test plugins:
// gain ×0.5 and a 64-frame delay that reports its latency.
//   node fx/test/net-fx-test.js build/Release/harbor-fx build/test-plugins/harbor-test-gain.clap
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../../index.js');

const [fxBinary, plugin] = process.argv.slice(2).map((p) => path.resolve(p));
const RATE = 44100;
const FRAMES = RATE * 3;
let failed = 0;

function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed += 1;
}

/** A 16-bit stereo WAV: a sine left, a ramp right — every frame tells where it is. */
function writeWav(file) {
  const data = Buffer.alloc(FRAMES * 4);
  for (let i = 0; i < FRAMES; i += 1) {
    data.writeInt16LE(Math.round(Math.sin(i / 7) * 16000), i * 4);
    data.writeInt16LE(((i % 20000) - 10000) * 2, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

/** Samples as floats (±1) from 16- or 24-bit little-endian. */
function samples(buf, bits) {
  const bytes = bits / 8;
  const out = new Float64Array(buf.length / bytes);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = bits === 16 ? buf.readInt16LE(i * 2) / 32768 : buf.readIntLE(i * 3, 3) / 8388608;
  }
  return out;
}

/** Largest difference between `got` and `want` × gain. */
function deviation(got, want, gain) {
  let worst = 0;
  for (let i = 0; i < want.length; i += 1) worst = Math.max(worst, Math.abs(got[i] - want[i] * gain));
  return worst;
}

async function main() {
  engine.fxSetBinary(fxBinary);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'net-fx-')), 'test.wav');
  writeWav(file);
  const dry = await engine.netStreamOpen(file, {});
  const want = (start, count) => engine.netStreamRead(dry.handle, start, count).then((b) => samples(b, 16));

  const chain = (ids) =>
    engine.fxRequest(
      JSON.stringify({
        cmd: 'setChain',
        inserts: ids.map((id) => ({ id, format: 'clap', path: plugin, pluginId: `harbor.test.${id}` })),
      })
    );
  await chain(['gain', 'delay']);

  const wet = await engine.netStreamOpen(file, { fx: true });
  check(wet.bitsPerSample === 24 && wet.frameCount === FRAMES, `24-bit, all ${FRAMES} frames`);
  const read = (start, count) => engine.netStreamRead(wet.handle, start, count).then((b) => samples(b, 24));
  const tolerance = 1e-6;

  // In order, in odd sizes: the chain runs on and the latency is compensated to the frame.
  let pos = 0;
  let worst = 0;
  for (const n of [1000, 4321, 777, 20000]) {
    worst = Math.max(worst, deviation(await read(pos, n), await want(pos, n), 0.5));
    pos += n;
  }
  check(worst < tolerance, `in order: half the dry signal, frame for frame (worst ${worst.toExponential(1)})`);

  // A jump (Range request, seek): prepared again, warmed up, still aligned.
  worst = deviation(await read(90000, 3000), await want(90000, 3000), 0.5);
  check(worst < tolerance, `after a jump to 90000 (worst ${worst.toExponential(1)})`);
  worst = deviation(await read(10, 500), await want(10, 500), 0.5);
  check(worst < tolerance, `a jump back near the start (worst ${worst.toExponential(1)})`);

  // The end: the tail of the delay comes out, nothing is cut.
  const tail = await read(FRAMES - 1500, 4000);
  check(tail.length === 1500 * 2, 'reads stop at the last frame');
  worst = deviation(tail, await want(FRAMES - 1500, 1500), 0.5);
  check(worst < tolerance, `the last frames (worst ${worst.toExponential(1)})`);

  // Whole rack bypassed: the file's frames, untouched (16-bit values in 24 bits).
  engine.fxSetBypass(true);
  worst = deviation(await read(5000, 2000), await want(5000, 2000), 1);
  check(worst === 0, 'bypassed: the file untouched');
  engine.fxSetBypass(false);
  worst = deviation(await read(7000, 2000), await want(7000, 2000), 0.5);
  check(worst < tolerance, `back in circuit (worst ${worst.toExponential(1)})`);

  // Empty rack: untouched too.
  await chain([]);
  worst = deviation(await read(9000, 2000), await want(9000, 2000), 1);
  check(worst === 0, 'empty rack: the file untouched');

  engine.netStreamClose(wet.handle);
  engine.netStreamClose(dry.handle);
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
