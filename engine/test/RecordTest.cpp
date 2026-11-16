// The recording path against known input (not shipped): build/record-test <scratch dir>
// Writes raw takes (PCM 16 in 24, 24-bit, DoP, IEC 61937, silences), finishes them and checks every
// output sample: FLAC through the `flac` tool (skipped when it is not installed), DSF and .spdif
// byte by byte. Also records a WAV through the file: input and compares it with the source.

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <string>
#include <thread>
#include <vector>

#include "record/Finalize.h"
#include "record/RawWav.h"
#include "record/Recorder.h"

namespace {

int failures = 0;

void check(bool ok, const std::string& what) {
  std::printf("%s %s\n", ok ? "  ok  " : "  FAIL", what.c_str());
  if (!ok) ++failures;
}

std::string dir;

std::string path(const std::string& name) { return dir + "/" + name; }

/** Frames, left-justified 32-bit, interleaved stereo. */
using Take = std::vector<int32_t>;

void appendSine(Take& t, uint32_t rate, double seconds, int bits, double amp, double hz) {
  const size_t n = size_t(seconds * rate);
  const double full = std::ldexp(1.0, bits - 1) - 1;
  for (size_t i = 0; i < n; ++i) {
    const double v = amp * full * std::sin(2 * M_PI * hz * double(i) / rate);
    const int32_t s = int32_t(std::lround(v));
    t.push_back(int32_t(uint32_t(s) << (32 - bits)));
    t.push_back(int32_t(uint32_t(-s) << (32 - bits)));
  }
}

void appendNoise(Take& t, size_t frames, int bits, std::mt19937& rng) {
  std::uniform_int_distribution<int32_t> d(-(1 << (bits - 1)), (1 << (bits - 1)) - 1);
  for (size_t i = 0; i < frames * 2; ++i) t.push_back(int32_t(uint32_t(d(rng)) << (32 - bits)));
}

void appendZeros(Take& t, size_t frames) { t.insert(t.end(), frames * 2, 0); }

/** DoP frames carrying `dsd` (per channel, MSB-first bytes), 2 bytes per frame. */
void appendDop(Take& t, const std::vector<uint8_t>& left, const std::vector<uint8_t>& right, bool& markerA) {
  for (size_t i = 0; i + 1 < left.size(); i += 2) {
    const uint32_t m = markerA ? 0x05 : 0xFA;
    markerA = !markerA;
    t.push_back(int32_t((m << 24) | (uint32_t(left[i]) << 16) | (uint32_t(left[i + 1]) << 8)));
    t.push_back(int32_t((m << 24) | (uint32_t(right[i]) << 16) | (uint32_t(right[i + 1]) << 8)));
  }
}

/** IEC 61937 bursts: Pa Pb Pc Pd, payload, zero padding; one burst per `period` frames. */
std::vector<uint16_t> appendBursts(Take& t, int bursts, size_t period, std::mt19937& rng) {
  std::vector<uint16_t> words;
  std::uniform_int_distribution<int> d(0, 0xFFFF);
  for (int b = 0; b < bursts; ++b) {
    std::vector<uint16_t> burst(period * 2, 0);
    burst[0] = 0xF872;
    burst[1] = 0x4E1F;
    burst[2] = 0x0001; // AC-3
    burst[3] = uint16_t(period * 2 * 8 / 3);
    for (size_t i = 4; i < period; ++i) burst[i] = uint16_t(d(rng));
    for (uint16_t w : burst) {
      t.push_back(int32_t(uint32_t(w) << 16));
      words.push_back(w);
    }
  }
  return words;
}

bool writeRaw(const std::string& file, const Take& t, uint32_t rate, int validBits) {
  RawWavWriter w;
  std::string error;
  if (!w.open(file, rate, 2, validBits, error)) return false;
  return w.write(t.data(), t.size() / 2) && w.close();
}

std::vector<uint8_t> readFile(const std::string& file) {
  std::vector<uint8_t> out;
  FILE* f = std::fopen(file.c_str(), "rb");
  if (!f) return out;
  uint8_t buf[65536];
  size_t n;
  while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) out.insert(out.end(), buf, buf + n);
  std::fclose(f);
  return out;
}

bool haveFlac() { return std::system("flac --version > /dev/null 2>&1") == 0; }

/** The FLAC decoded by the reference tool equals frames [from, to) of the take at `bits`. */
bool flacMatches(const std::string& file, const Take& t, size_t from, size_t to, int bits) {
  const std::string out = file + ".decoded.raw";
  const std::string cmd = "flac -s -d -f --force-raw-format --endian=little --sign=signed -o '" + out + "' '" + file + "'";
  if (std::system(cmd.c_str()) != 0) return false;
  const std::vector<uint8_t> raw = readFile(out);
  std::remove(out.c_str());
  const size_t bytes = size_t(bits / 8);
  if (raw.size() != (to - from) * 2 * bytes) return false;
  for (size_t i = 0; i < (to - from) * 2; ++i) {
    uint32_t v = 0;
    for (size_t b = 0; b < bytes; ++b) v |= uint32_t(raw[i * bytes + b]) << (8 * b);
    const uint32_t want = uint32_t(t[from * 2 + i]) >> (32 - bits);
    if ((v & ((bits == 32 ? 0 : (1u << bits)) - 1)) != (want & ((bits == 32 ? 0 : (1u << bits)) - 1))) return false;
  }
  return std::system(("flac -s -t '" + file + "'").c_str()) == 0;
}

void testPcmSplit(bool flac) {
  std::puts("PCM 16 in 24, split at silence");
  const uint32_t rate = 44100;
  Take t;
  std::mt19937 rng(1);
  appendSine(t, rate, 3.0, 16, 0.5, 997);
  const size_t a = t.size() / 2;
  appendZeros(t, rate * 3);
  const size_t b = t.size() / 2;
  appendNoise(t, rate * 2 + 1234, 16, rng); // odd length: a short last block
  const size_t c = t.size() / 2;
  appendZeros(t, rate * 3);
  check(writeRaw(path("pcm16.raw.wav"), t, rate, 24), "raw take written");

  FinalizeOptions o;
  o.rawPath = path("pcm16.raw.wav");
  o.outDir = dir;
  o.split = true;
  o.silenceSeconds = 2.0;
  o.titleBase = "pcm16";
  o.tags = {{"ALBUM", "Test"}};
  FinalizeResult r;
  std::string error;
  check(finalizeTake(o, r, error), "finalized " + error);
  check(r.files.size() == 2, "two tracks (got " + std::to_string(r.files.size()) + ")");
  if (r.files.size() != 2) return;
  check(r.files[0].kind == "flac" && r.files[0].bits == 16, "track 1: 16-bit FLAC");
  check(r.files[1].kind == "flac" && r.files[1].bits == 16, "track 2: 16-bit FLAC");
  // Cuts in the middle of each silence.
  const size_t cut1 = a + (b - a) / 2;
  check(r.files[0].frames == cut1, "track 1 ends mid-silence");
  if (flac) {
    check(flacMatches(r.files[0].path, t, 0, cut1, 16), "track 1 decodes bit-exact");
    const size_t cut2 = cut1 + size_t(r.files[1].frames);
    check(cut2 > c + rate && cut2 < t.size() / 2, "track 2 ends in the trailing silence");
    check(flacMatches(r.files[1].path, t, cut1, cut2, 16), "track 2 decodes bit-exact");
  }
}

void testPcm24(bool flac) {
  std::puts("PCM 24-bit at 96 kHz, no split");
  const uint32_t rate = 96000;
  Take t;
  std::mt19937 rng(2);
  appendSine(t, rate, 1.0, 24, 0.9, 1000);
  appendNoise(t, 5000, 24, rng);
  appendZeros(t, rate);
  appendSine(t, rate, 0.5, 24, 1.0, 20000); // full scale
  check(writeRaw(path("pcm24.raw.wav"), t, rate, 24), "raw take written");
  FinalizeOptions o;
  o.rawPath = path("pcm24.raw.wav");
  o.outDir = dir;
  o.titleBase = "pcm24";
  FinalizeResult r;
  std::string error;
  check(finalizeTake(o, r, error), "finalized " + error);
  check(r.files.size() == 1 && r.files[0].bits == 24, "one 24-bit FLAC");
  if (flac && r.files.size() == 1) check(flacMatches(r.files[0].path, t, 0, t.size() / 2, 24), "decodes bit-exact");
}

void testDop(bool flac) {
  std::puts("PCM → DoP (DSD64) → PCM");
  const uint32_t rate = 176400;
  Take t;
  std::mt19937 rng(3);
  appendSine(t, rate, 0.5, 24, 0.5, 440);
  const size_t dopStart = t.size() / 2;
  std::uniform_int_distribution<int> d(0, 255);
  std::vector<uint8_t> left(rate * 2 * 2), right(rate * 2 * 2); // 2 s
  for (auto& v : left) v = uint8_t(d(rng));
  for (auto& v : right) v = uint8_t(d(rng));
  bool markerA = true;
  appendDop(t, left, right, markerA);
  const size_t dopEnd = t.size() / 2;
  appendSine(t, rate, 0.5, 24, 0.5, 880);
  check(writeRaw(path("dop.raw.wav"), t, rate, 24), "raw take written");

  FinalizeOptions o;
  o.rawPath = path("dop.raw.wav");
  o.outDir = dir;
  o.titleBase = "dop";
  FinalizeResult r;
  std::string error;
  check(finalizeTake(o, r, error), "finalized " + error);
  check(r.files.size() == 3, "three files (got " + std::to_string(r.files.size()) + ")");
  if (r.files.size() != 3) return;
  check(r.files[0].kind == "flac" && r.files[0].frames == dopStart, "PCM before, up to the first DoP frame");
  check(r.files[1].kind == "dsf" && r.files[1].frames == dopEnd - dopStart, "DoP as DSF, frame-exact");
  check(r.files[1].sampleRate == 2822400, "DSD64 rate");
  check(r.files[2].kind == "flac", "PCM after");
  if (flac) {
    check(flacMatches(r.files[0].path, t, 0, dopStart, 24), "PCM before decodes bit-exact");
    check(flacMatches(r.files[2].path, t, dopEnd, t.size() / 2, 24), "PCM after decodes bit-exact");
  }
  // DSF: header, then 4096-byte blocks per channel, LSB first.
  const std::vector<uint8_t> dsf = readFile(r.files[1].path);
  bool same = dsf.size() >= 92 && std::memcmp(dsf.data(), "DSD ", 4) == 0;
  uint64_t samples = 0;
  if (same) for (int i = 0; i < 8; ++i) samples |= uint64_t(dsf[28 + 12 + 24 + i]) << (8 * i);
  check(same && samples == left.size() * 8, "DSF sample count");
  auto rev = [](uint8_t b) {
    uint8_t r = 0;
    for (int i = 0; i < 8; ++i) r = uint8_t(r | (((b >> i) & 1) << (7 - i)));
    return r;
  };
  for (size_t i = 0; same && i < left.size(); ++i) {
    const size_t block = i / 4096, off = i % 4096;
    const size_t at = 92 + block * 8192;
    same = at + 4096 + off < dsf.size() && dsf[at + off] == rev(left[i]) && dsf[at + 4096 + off] == rev(right[i]);
  }
  check(same, "DSF carries every DSD bit");
}

void testBitstream(bool flac) {
  std::puts("PCM → IEC 61937 bitstream");
  const uint32_t rate = 48000;
  Take t;
  std::mt19937 rng(4);
  appendSine(t, rate, 1.0, 16, 0.3, 300);
  const size_t start = t.size() / 2;
  const std::vector<uint16_t> words = appendBursts(t, 60, 1536, rng);
  const size_t end = t.size() / 2;
  appendZeros(t, rate); // silence after: no file
  check(writeRaw(path("iec.raw.wav"), t, rate, 24), "raw take written");
  FinalizeOptions o;
  o.rawPath = path("iec.raw.wav");
  o.outDir = dir;
  o.titleBase = "iec";
  FinalizeResult r;
  std::string error;
  check(finalizeTake(o, r, error), "finalized " + error);
  check(r.files.size() == 2, "two files (got " + std::to_string(r.files.size()) + ")");
  if (r.files.size() != 2) return;
  check(r.files[0].kind == "flac" && r.files[0].frames == start, "PCM up to the first burst");
  if (flac) check(flacMatches(r.files[0].path, t, 0, start, 16), "PCM decodes bit-exact");
  check(r.files[1].kind == "spdif" && r.files[1].frames == end - start, "bitstream frame-exact");
  const std::vector<uint8_t> raw = readFile(r.files[1].path);
  bool same = raw.size() == words.size() * 2;
  for (size_t i = 0; same && i < words.size(); ++i) same = (raw[i * 2] | (raw[i * 2 + 1] << 8)) == words[i];
  check(same, ".spdif carries every bitstream word");
}

void testRecorder() {
  std::puts("Recorder: WAV in through the file input");
  const uint32_t rate = 48000;
  Take t;
  std::mt19937 rng(5);
  appendNoise(t, rate * 3 + 77, 24, rng);
  check(writeRaw(path("source.wav"), t, rate, 24), "source written");
  RecorderStartOptions o;
  o.device = "filefast:" + path("source.wav");
  o.rate = rate;
  o.rawPath = path("recorded.raw.wav");
  std::string error;
  check(recorderStart(o, error), "started " + error);
  for (int i = 0; i < 200 && recorderStatus().frames < t.size() / 2; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  const RecorderStatus st = recorderStop();
  check(st.frames == t.size() / 2, "every frame recorded (" + std::to_string(st.frames) + ")");
  check(st.overruns == 0 && st.dropped == 0, "no overruns, nothing dropped");
  check(st.bits == 24 && st.content == "pcm", "live: 24-bit PCM");
  WavReader in;
  check(in.open(o.rawPath, error), "raw take readable");
  Take back(t.size());
  check(in.read(0, t.size() / 2, back.data()) == t.size() / 2 && back == t, "raw take identical to the source");

  std::puts("Recorder: wrong rate is refused");
  o.rate = 44100;
  check(!recorderStart(o, error), "refused: " + error);
}

} // namespace

/** record-test <dir> --alsa <device> <rate>: one second from a real input, e.g. on the Pi. */
int alsaSmoke(const std::string& device, uint32_t rate) {
  std::printf("ALSA: 1 s from %s at %u Hz\n", device.c_str(), rate);
  RecorderStartOptions o;
  o.device = device;
  o.rate = rate;
  o.rawPath = path("alsa.raw.wav");
  std::string error;
  if (!recorderStart(o, error)) {
    std::printf("  could not start: %s\n", error.c_str());
    return 1;
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(1200));
  const RecorderStatus st = recorderStop();
  std::printf("  frames %llu, device bits %d, overruns %llu, dropped %llu, signal %d, content %s, bits %d%s%s\n",
              (unsigned long long)st.frames, st.deviceBits, (unsigned long long)st.overruns,
              (unsigned long long)st.dropped, st.signal ? 1 : 0, st.content.c_str(), st.bits,
              st.error.empty() ? "" : ", error: ", st.error.c_str());
  return st.frames > 0 ? 0 : 1;
}

int main(int argc, char** argv) {
  dir = argc > 1 ? argv[1] : ".";
  if (argc > 4 && std::string(argv[2]) == "--alsa") return alsaSmoke(argv[3], uint32_t(std::atoi(argv[4])));
  const bool flac = haveFlac();
  if (!flac) std::puts("(flac not installed: FLAC output is checked only for its structure)");
  testPcmSplit(flac);
  testPcm24(flac);
  testDop(flac);
  testBitstream(flac);
  testRecorder();
  std::printf("%s\n", failures ? "FAILED" : "All recording tests passed");
  return failures ? 1 : 0;
}
