// The native ALAC decoder (AlacReader + Apple's decoder) against a reference decode: every sample
// the same, read straight through and from random places; AAC handed on; broken files refused
// without a crash.
//
// Run: alac-test <file.m4a>…   each ALAC file needs <file.m4a>.s32 next to it — the reference as
// interleaved 32-bit little-endian, left-justified (ffmpeg -i f.m4a -f s32le -c:a pcm_s32le f.m4a.s32).
// A file named *aac*.m4a is checked to be handed on, not decoded. The first ALAC file is also
// damaged on purpose (cut, noise, flipped bytes): ALAC_TEST_ROUNDS copies, 60 by default.
#include "AlacReader.h"
#include "FrameSource.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <random>
#include <string>
#include <vector>

namespace {

int g_failures = 0;

void check(bool ok, const std::string& what) {
  std::printf("%s %s\n", ok ? "ok  " : "FAIL", what.c_str());
  if (!ok) ++g_failures;
}

std::vector<uint8_t> readAll(const std::string& path) {
  std::vector<uint8_t> data;
  if (std::FILE* f = std::fopen(path.c_str(), "rb")) {
    uint8_t buf[1 << 16];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) data.insert(data.end(), buf, buf + n);
    std::fclose(f);
  }
  return data;
}

bool writeAll(const std::string& path, const std::vector<uint8_t>& data) {
  std::FILE* f = std::fopen(path.c_str(), "wb");
  if (!f) return false;
  const bool ok = std::fwrite(data.data(), 1, data.size(), f) == data.size();
  std::fclose(f);
  return ok;
}

std::string base(const std::string& path) {
  const size_t slash = path.find_last_of('/');
  return slash == std::string::npos ? path : path.substr(slash + 1);
}

void checkAlac(const std::string& path) {
  const std::string name = base(path);
  const std::vector<uint8_t> refBytes = readAll(path + ".s32");
  if (refBytes.empty()) {
    check(false, name + ": reference " + name + ".s32 missing");
    return;
  }
  std::vector<int32_t> ref(refBytes.size() / 4);
  std::memcpy(ref.data(), refBytes.data(), ref.size() * 4);

  AlacReader reader;
  std::string error;
  bool notAlac = false;
  if (!reader.open(path, error, notAlac)) {
    check(false, name + ": open — " + error);
    return;
  }
  const unsigned ch = reader.channels();
  const uint64_t frames = reader.frameCount();
  char info[160];
  std::snprintf(info, sizeof(info), "%s: %u Hz, %u ch, %u-bit, %llu frames", name.c_str(), reader.sampleRate(),
                ch, reader.bitDepth(), (unsigned long long)frames);
  check(frames * ch == ref.size(), std::string(info) + " — length matches the reference");
  if (frames * ch != ref.size()) return;

  // Straight through, in odd-sized reads.
  std::vector<int32_t> got(ref.size());
  uint64_t at = 0;
  bool straight = true;
  while (at < frames) {
    const size_t want = size_t(std::min<uint64_t>(1237, frames - at));
    const size_t n = reader.readS32(at, want, got.data() + at * ch);
    if (n != want) {
      straight = false;
      break;
    }
    at += n;
  }
  size_t firstDiff = SIZE_MAX;
  for (size_t i = 0; straight && i < ref.size(); ++i) {
    if (got[i] != ref[i]) {
      firstDiff = i;
      straight = false;
    }
  }
  check(straight, name + ": every sample bit-exact, read straight through" +
                      (firstDiff != SIZE_MAX ? " (first difference at sample " + std::to_string(firstDiff) + ")" : ""));

  // From random places, backwards and forwards (a seek in the remote, a network player's range).
  std::mt19937_64 rng(42);
  bool random = true;
  std::vector<int32_t> part;
  for (int i = 0; i < 200 && random; ++i) {
    const uint64_t start = rng() % frames;
    const size_t count = size_t(1 + rng() % 9000);
    part.assign(size_t(count) * ch, 0);
    const size_t n = reader.readS32(start, count, part.data());
    const size_t expect = size_t(std::min<uint64_t>(count, frames - start));
    if (n != expect || std::memcmp(part.data(), ref.data() + start * ch, n * ch * 4) != 0) random = false;
  }
  check(random, name + ": 200 reads from random places bit-exact");
  check(reader.readS32(frames, 10, part.data()) == 0, name + ": nothing past the end");

  // Through FrameSource, as the player and the network stream read it.
  FrameSourceOptions options;
  auto source = openFrameSource(path, options, error);
  if (!source) {
    check(false, name + ": openFrameSource — " + error);
    return;
  }
  std::vector<float> floats(size_t(4096) * ch);
  const size_t nf = source->readFloat(frames / 3, 4096, floats.data());
  bool floatOk = nf == std::min<uint64_t>(4096, frames - frames / 3);
  for (size_t i = 0; floatOk && i < nf * ch; ++i) {
    floatOk = floats[i] == float(ref[(frames / 3) * ch + i]) * (1.0f / 2147483648.0f);
  }
  check(floatOk, name + ": readFloat matches");
  const uint16_t bits = source->bitsPerSample();
  std::vector<uint8_t> packed(size_t(4096) * ch * (bits / 8));
  const size_t np = source->readPacked(0, 4096, packed.data());
  bool packedOk = np == std::min<uint64_t>(4096, frames);
  for (size_t i = 0; packedOk && i < np * ch; ++i) {
    const int32_t r = ref[i];
    if (bits == 16) {
      const int32_t v = int16_t(uint16_t(packed[i * 2] | (packed[i * 2 + 1] << 8)));
      packedOk = v == (r >> 16);
    } else {
      int32_t v = int32_t(uint32_t(packed[i * 3]) | (uint32_t(packed[i * 3 + 1]) << 8) |
                          (uint32_t(packed[i * 3 + 2]) << 16));
      if (v & 0x800000) v -= 0x1000000;
      packedOk = v == (r >> 8);
    }
  }
  check(packedOk, name + ": readPacked " + std::to_string(bits) + "-bit matches");
}

void checkHandedOn(const std::string& path) {
  AlacReader reader;
  std::string error;
  bool notAlac = false;
  const bool opened = reader.open(path, error, notAlac);
  check(!opened && notAlac, base(path) + ": not ALAC — handed on to another decoder");
}

/** Broken copies of an ALAC file: open and read must fail or return less, never crash. */
void checkBroken(const std::string& path, const std::string& dir) {
  const std::vector<uint8_t> good = readAll(path);
  std::mt19937_64 rng(7);
  int survived = 0;
  // ALAC_TEST_ROUNDS=2000 for a longer run (under AddressSanitizer, say).
  const char* env = std::getenv("ALAC_TEST_ROUNDS");
  const int rounds = env ? std::max(1, std::atoi(env)) : 60;
  for (int round = 0; round < rounds; ++round) {
    std::vector<uint8_t> bad = good;
    if (round < 10) {
      bad.resize(size_t(rng() % bad.size())); // cut short
    } else if (round < 20) {
      for (auto& b : bad) b = uint8_t(rng()); // noise
    } else {
      const int flips = 1 + int(rng() % 200); // damaged in places, tables or audio
      for (int i = 0; i < flips; ++i) bad[size_t(rng() % bad.size())] ^= uint8_t(1 + rng() % 255);
    }
    const std::string file = dir + "/broken.m4a";
    if (!writeAll(file, bad)) continue;
    AlacReader reader;
    std::string error;
    bool notAlac = false;
    if (reader.open(file, error, notAlac)) {
      std::vector<int32_t> buf(size_t(8192) * reader.channels());
      for (uint64_t at = 0; at < reader.frameCount(); at += 8192) {
        if (reader.readS32(at, 8192, buf.data()) == 0) break;
      }
    }
    ++survived;
  }
  check(survived == rounds, base(path) + ": " + std::to_string(rounds) + " broken copies refused or read without a crash");
}

} // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: alac-test <file.m4a>…\n");
    return 2;
  }
  std::string firstAlac;
  for (int i = 1; i < argc; ++i) {
    const std::string path = argv[i];
    if (base(path).find("aac") != std::string::npos) {
      checkHandedOn(path);
    } else {
      checkAlac(path);
      if (firstAlac.empty()) firstAlac = path;
    }
  }
  if (!firstAlac.empty()) {
    const size_t slash = firstAlac.find_last_of('/');
    checkBroken(firstAlac, slash == std::string::npos ? "." : firstAlac.substr(0, slash));
  }
  std::printf(g_failures ? "\n%d FAILED\n" : "\nall passed\n", g_failures);
  return g_failures ? 1 : 0;
}
