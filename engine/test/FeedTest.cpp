// PlaybackFeed against FrameSource read straight: the ring a player plays from gives the same
// frames, in order and after seeks, while holding only a few seconds of the track.
// Run: feed-test [dir for the test files]
#include "FrameSource.h"
#include "PlaybackFeed.h"

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <type_traits>
#include <vector>

namespace {

int g_failures = 0;

void check(bool ok, const std::string& what) {
  std::printf("%s %s\n", ok ? "ok  " : "FAIL", what.c_str());
  if (!ok) ++g_failures;
}

void put32(std::vector<uint8_t>& b, uint32_t v) {
  for (int i = 0; i < 4; ++i) b.push_back(uint8_t(v >> (8 * i)));
}
void put64(std::vector<uint8_t>& b, uint64_t v) {
  for (int i = 0; i < 8; ++i) b.push_back(uint8_t(v >> (8 * i)));
}
void putId(std::vector<uint8_t>& b, const char* id) {
  b.insert(b.end(), id, id + 4);
}

/** A stereo DSF: `seconds` of noise-like DSD at `rate`, 4096-byte blocks, the last one padded. */
bool writeDsf(const std::string& path, uint32_t rate, double seconds) {
  const uint32_t block = 4096;
  const uint64_t samples = uint64_t(double(rate) * seconds);
  const uint64_t bytesPerChannel = samples / 8;
  const uint64_t blocks = (bytesPerChannel + block - 1) / block;
  const uint64_t dataBytes = blocks * block * 2;
  std::vector<uint8_t> b;
  putId(b, "DSD ");
  put64(b, 28);
  put64(b, 28 + 52 + 12 + dataBytes);
  put64(b, 0);
  putId(b, "fmt ");
  put64(b, 52);
  put32(b, 1);     // version
  put32(b, 0);     // DSD raw
  put32(b, 2);     // stereo
  put32(b, 2);     // channels
  put32(b, rate);
  put32(b, 1);     // LSB first
  put64(b, samples);
  put32(b, block);
  put32(b, 0);
  putId(b, "data");
  put64(b, 12 + dataBytes);
  uint32_t x = 0x12345678;
  b.reserve(b.size() + dataBytes);
  for (uint64_t i = 0; i < dataBytes; ++i) {
    x = x * 1664525u + 1013904223u;
    b.push_back(uint8_t(x >> 24));
  }
  FILE* f = std::fopen(path.c_str(), "wb");
  if (!f) return false;
  const bool ok = std::fwrite(b.data(), 1, b.size(), f) == b.size();
  return std::fclose(f) == 0 && ok;
}

/** A 16-bit stereo WAV with a ramp. */
bool writeWav(const std::string& path, uint32_t rate, uint32_t frames) {
  std::vector<uint8_t> b;
  putId(b, "RIFF");
  put32(b, 36 + frames * 4);
  putId(b, "WAVE");
  putId(b, "fmt ");
  put32(b, 16);
  b.push_back(1); b.push_back(0);  // PCM
  b.push_back(2); b.push_back(0);  // channels
  put32(b, rate);
  put32(b, rate * 4);
  b.push_back(4); b.push_back(0);
  b.push_back(16); b.push_back(0);
  putId(b, "data");
  put32(b, frames * 4);
  for (uint32_t i = 0; i < frames; ++i) {
    const int16_t l = int16_t((i * 7) & 0x7fff);
    const int16_t r = int16_t(-int32_t((i * 3) & 0x7fff));
    b.push_back(uint8_t(l)); b.push_back(uint8_t(l >> 8));
    b.push_back(uint8_t(r)); b.push_back(uint8_t(r >> 8));
  }
  FILE* f = std::fopen(path.c_str(), "wb");
  if (!f) return false;
  const bool ok = std::fwrite(b.data(), 1, b.size(), f) == b.size();
  return std::fclose(f) == 0 && ok;
}

/** The whole track straight from a FrameSource: what the feed must hand out. */
template <typename T>
std::vector<T> reference(const std::string& path, const FrameSourceOptions& options, uint64_t& frames,
                         uint16_t& channels) {
  std::string error;
  auto source = openFrameSource(path, options, error);
  std::vector<T> all;
  if (!source) return all;
  frames = source->frameCount();
  channels = source->channels();
  all.resize(size_t(frames) * channels);
  uint64_t pos = 0;
  while (pos < frames) {
    const size_t want = size_t(std::min<uint64_t>(4096, frames - pos));
    size_t n = 0;
    if constexpr (std::is_same_v<T, int32_t>) {
      n = source->readDop(pos, want, all.data() + pos * channels);
    } else {
      n = source->readFloat(pos, want, all.data() + pos * channels);
    }
    if (n == 0) break;
    pos += n;
  }
  all.resize(size_t(pos) * channels);
  frames = pos;
  return all;
}

template <typename T>
size_t readFeed(const PlaybackFeed& feed, uint64_t pos, T* out, size_t frames) {
  if constexpr (std::is_same_v<T, int32_t>) return feed.readDop(pos, out, frames);
  else return feed.readFloat(pos, out, frames);
}

/**
 * Plays `frames` frames from `pos` like a device thread: 1024 at a time, the playhead reported
 * after each. False on a mismatch or when the feed stalls for a second.
 */
template <typename T>
bool play(PlaybackFeed& feed, const std::vector<T>& ref, uint16_t ch, uint64_t pos, uint64_t frames) {
  std::vector<T> buf(1024 * ch);
  const uint64_t end = pos + frames;
  int idle = 0;
  while (pos < end) {
    const size_t want = size_t(std::min<uint64_t>(1024, end - pos));
    const size_t n = readFeed(feed, pos, buf.data(), want);
    if (n == 0) {
      if (++idle > 1000) {
        std::printf("     stalled at frame %llu\n", (unsigned long long)pos);
        return false;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      continue;
    }
    idle = 0;
    if (std::memcmp(buf.data(), ref.data() + pos * ch, n * ch * sizeof(T)) != 0) {
      std::printf("     mismatch at frame %llu\n", (unsigned long long)pos);
      return false;
    }
    pos += n;
    feed.consume(pos);
  }
  return true;
}

template <typename T>
void suite(const std::string& name, const std::string& path, const FrameSourceOptions& options) {
  uint64_t frames = 0;
  uint16_t ch = 0;
  const std::vector<T> ref = reference<T>(path, options, frames, ch);
  check(frames > 0, name + ": reference decoded (" + std::to_string(frames) + " frames)");
  if (!frames) return;

  PlaybackFeed feed;
  std::string error;
  check(feed.open(path, options, error), name + ": opens " + error);
  check(feed.frameCount() == frames && feed.channels() == ch, name + ": same length and channels");
  check(feed.isDop() == options.dop, name + ": DoP as asked");
  check(feed.waitReady(0, 4096, 5000), name + ": first quantum ready");

  // The worker never runs further ahead than the ring, and the ring is not the track.
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  check(feed.available(0) <= feed.capacity(), name + ": decodes no further ahead than the ring");
  if (frames > feed.capacity() * 2) {
    check(feed.available(0) < frames, name + ": not the whole track at once");
  }

  check(play(feed, ref, ch, 0, frames), name + ": in order to the last frame, through the ring");
  std::vector<T> tail(ch);
  check(feed.available(frames) == 0 && readFeed(feed, frames, tail.data(), 1) == 0, name + ": nothing past the end");

  const uint64_t far = frames * 3 / 5;
  feed.seek(far);
  check(play(feed, ref, ch, far, std::min<uint64_t>(frames - far, 50000)), name + ": seek forward");
  const uint64_t back = 777;
  feed.seek(back);
  check(play(feed, ref, ch, back, std::min<uint64_t>(frames - back, 50000)), name + ": seek back");

  // A playhead from before a seek is ignored.
  feed.seek(far);
  feed.consume(back + 10);
  check(play(feed, ref, ch, far, std::min<uint64_t>(frames - far, 20000)), name + ": stale playhead ignored");

  // Old positions are refused once the playhead passed them.
  check(readFeed(feed, back, tail.data(), 1) == 0, name + ": frames behind the playhead refused");

  feed.close();
  check(feed.capacity() == 0 && feed.endFrame() == 0, name + ": closed, ring freed");
}

} // namespace

int main(int argc, char** argv) {
  const std::string dir = argc > 1 ? argv[1] : "/tmp";
  const std::string dsf64 = dir + "/feed-test-dsd64.dsf";
  const std::string dsf128 = dir + "/feed-test-dsd128.dsf";
  const std::string wav = dir + "/feed-test.wav";
  check(writeDsf(dsf64, 2822400, 12.0), "DSF DSD64 written");
  check(writeDsf(dsf128, 5644800, 10.0), "DSF DSD128 written");
  check(writeWav(wav, 44100, 44100 * 20), "WAV written");

  FrameSourceOptions dop;
  dop.dop = true;
  suite<int32_t>("DSD64 DoP", dsf64, dop);
  suite<int32_t>("DSD128 DoP", dsf128, dop);
  FrameSourceOptions pcm;
  suite<float>("DSD64 → PCM", dsf64, pcm);
  suite<float>("WAV", wav, pcm);

  // Open and close at once, again and again: no worker left behind.
  {
    PlaybackFeed feed;
    std::string error;
    bool ok = true;
    for (int i = 0; i < 50 && ok; ++i) {
      ok = feed.open(i % 2 ? dsf64 : wav, i % 3 ? dop : pcm, error);
      if (i % 5 == 0) feed.seek(uint64_t(i) * 1000);
      feed.close();
    }
    check(ok, "open / seek / close 50 times");
  }

  std::remove(dsf64.c_str());
  std::remove(dsf128.c_str());
  std::remove(wav.c_str());
  std::printf(g_failures ? "%d failed\n" : "all passed\n", g_failures);
  return g_failures ? 1 : 0;
}
