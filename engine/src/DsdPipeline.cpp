#include "DsdPipeline.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <vector>
#if !defined(_WIN32)
#include <sys/types.h>
#endif

// MSVC does not expose M_PI from <cmath> without _USE_MATH_DEFINES
#ifndef M_PI
#define M_PI 3.14159265358979323846264338327950288
#endif

namespace {

uint32_t readU32(const uint8_t* p) {
  return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}

uint64_t readU64(const uint8_t* p) {
  return uint64_t(readU32(p)) | (uint64_t(readU32(p + 4)) << 32);
}

uint8_t bitReverse(uint8_t b) {
  uint8_t r = 0;
  for (int i = 0; i < 8; ++i) {
    if (b & (1u << i)) r |= uint8_t(1u << (7 - i));
  }
  return r;
}

double besselI0(double x) {
  double sum = 1.0;
  double term = 1.0;
  const double half = x / 2.0;
  for (int k = 1; k < 64; ++k) {
    term *= (half / double(k)) * (half / double(k));
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

std::vector<double> kaiserLowpass(double passband, double stopband, double sampleRate, int count = -1) {
  constexpr double attenuation = 120.0;
  const double transition = std::max(stopband - passband, 1.0) / sampleRate;
  const int estimate = int(std::ceil((attenuation - 7.95) / (14.36 * transition))) + 1;
  const int n = std::max(3, count > 0 ? count : estimate);
  const double beta = 0.1102 * (attenuation - 8.7);
  const double cutoff = (passband + stopband) / 2.0 / sampleRate;
  const double center = double(n - 1) / 2.0;
  const double i0Beta = besselI0(beta);
  std::vector<double> taps(static_cast<size_t>(n), 0.0);
  double sum = 0.0;
  for (int k = 0; k < n; ++k) {
    const double t = double(k) - center;
    const double sinc = t == 0.0 ? 2.0 * cutoff : std::sin(2.0 * M_PI * cutoff * t) / (M_PI * t);
    const double r = t / center;
    const double window = besselI0(beta * std::sqrt(std::max(0.0, 1.0 - r * r))) / i0Beta;
    taps[size_t(k)] = sinc * window;
    sum += taps[size_t(k)];
  }
  for (double& t : taps) t /= sum;
  return taps;
}

struct FirDesign {
  int stage1Bytes = 0;
  std::vector<float> stage1Table; // stage1Bytes * 257
  std::vector<std::vector<float>> halfStageTaps;
  int decimation = 32;
};

FirDesign makeDesign(uint32_t dsdRate, int decimation, double passbandHz = 0.0) {
  FirDesign d;
  d.decimation = decimation;
  const double outRate = double(dsdRate) / double(decimation);
  const int halfStages = std::max(1, int(std::lround(std::log2(double(decimation / 8)))));
  const double passband = passbandHz > 0.0 ? passbandHz : std::min(25000.0, outRate * 0.3);
  auto stopband = [&](double stageOutRate) { return stageOutRate - outRate / 2.0; };

  const double stage1Rate = double(dsdRate) / 8.0;
  auto stage1Taps = kaiserLowpass(passband, stopband(stage1Rate), double(dsdRate));
  d.stage1Bytes = int((stage1Taps.size() + 7) / 8);
  if (stage1Taps.size() < size_t(d.stage1Bytes) * 8) {
    stage1Taps = kaiserLowpass(passband, stopband(stage1Rate), double(dsdRate), d.stage1Bytes * 8);
  }
  d.stage1Table.assign(size_t(d.stage1Bytes) * 257, 0.0f);
  for (int j = 0; j < d.stage1Bytes; ++j) {
    for (int b = 0; b < 256; ++b) {
      double sum = 0.0;
      for (int i = 0; i < 8; ++i) {
        const bool on = ((b >> (7 - i)) & 1) == 1;
        sum += on ? stage1Taps[size_t(j * 8 + i)] : -stage1Taps[size_t(j * 8 + i)];
      }
      d.stage1Table[size_t(j * 257 + b)] = float(sum);
    }
  }

  double rate = stage1Rate;
  for (int s = 0; s < halfStages; ++s) {
    auto taps = kaiserLowpass(passband, stopband(rate / 2.0), rate);
    if (taps.size() % 2 == 0) {
      taps = kaiserLowpass(passband, stopband(rate / 2.0), rate, int(taps.size()) + 1);
    }
    std::vector<float> ft(taps.size());
    for (size_t i = 0; i < taps.size(); ++i) ft[i] = float(taps[i]);
    d.halfStageTaps.push_back(std::move(ft));
    rate /= 2.0;
  }
  return d;
}

struct HalfDecimator {
  std::vector<float> taps;
  std::vector<float> history;
  int write = 0;
  bool odd = false;
  float last = 0.0f;

  explicit HalfDecimator(std::vector<float> t)
    : taps(std::move(t)), history(taps.size() * 2, 0.0f) {}

  float* push(float x) {
    const int length = int(taps.size());
    history[size_t(write)] = x;
    history[size_t(write + length)] = x;
    write = write + 1 == length ? 0 : write + 1;
    odd = !odd;
    if (odd) return nullptr;
    float sum = 0.0f;
    const int start = write;
    for (int k = 0; k < length; ++k) sum += taps[size_t(k)] * history[size_t(start + k)];
    last = sum;
    return &last;
  }
};

struct ChannelDecim {
  std::vector<uint16_t> ring;
  int byteWrite = 0;
  std::vector<HalfDecimator> stages;
  size_t byteIndex = 0;
};

bool feedChannel(ChannelDecim& ch, const FirDesign& design, const uint8_t* bits, size_t totalBytes,
                 size_t channels, float gain, float& outSample) {
  while (ch.byteIndex < totalBytes) {
    const uint8_t b = bits[ch.byteIndex];
    const int length = design.stage1Bytes;
    ch.ring[size_t(ch.byteWrite)] = b;
    ch.ring[size_t(ch.byteWrite + length)] = b;
    ch.byteWrite = ch.byteWrite + 1 == length ? 0 : ch.byteWrite + 1;

    float value = 0.0f;
    const int start = ch.byteWrite;
    for (int j = 0; j < length; ++j) {
      const uint16_t wb = ch.ring[size_t(start + j)];
      if (wb > 255) continue;
      value += design.stage1Table[size_t(j * 257 + int(wb))];
    }

    bool have = true;
    for (auto& stage : ch.stages) {
      float* o = stage.push(value);
      if (!o) {
        have = false;
        break;
      }
      value = *o;
    }

    ch.byteIndex += channels;
    if (have) {
      value *= gain;
      if (value > 1.0f) value = 1.0f;
      if (value < -1.0f) value = -1.0f;
      outSample = value;
      return true;
    }
  }
  return false;
}

} // namespace

bool loadDsf(const std::string& path, DsdStream& out, std::string& error) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    error = "Cannot open DSF";
    return false;
  }
  std::vector<uint8_t> file((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  if (file.size() < 92 || std::memcmp(file.data(), "DSD ", 4) != 0) {
    error = "Not a DSF file";
    return false;
  }

  size_t fmt = std::string::npos;
  for (size_t i = 0; i + 4 < file.size(); ++i) {
    if (std::memcmp(file.data() + i, "fmt ", 4) == 0) {
      fmt = i;
      break;
    }
  }
  if (fmt == std::string::npos || fmt + 52 > file.size()) {
    error = "DSF missing fmt";
    return false;
  }

  const uint8_t* f = file.data() + fmt;
  out.channels = static_cast<uint16_t>(readU32(f + 24));
  out.sampleRate = readU32(f + 28);
  // DSF stores samples in per-channel blocks (typically 4096 bytes), not byte-interleaved.
  uint32_t blockSize = readU32(f + 44);
  if (blockSize == 0) blockSize = 4096;

  size_t data = std::string::npos;
  for (size_t i = 0; i + 4 < file.size(); ++i) {
    if (std::memcmp(file.data() + i, "data", 4) == 0) {
      data = i;
      break;
    }
  }
  if (data == std::string::npos || data + 12 > file.size()) {
    error = "DSF missing data";
    return false;
  }
  const uint64_t dataChunkSize = readU64(file.data() + data + 4);
  const size_t dataStart = data + 12;
  const size_t dataBytes = static_cast<size_t>(dataChunkSize > 12 ? dataChunkSize - 12 : 0);
  if (dataStart + dataBytes > file.size()) {
    error = "DSF truncated";
    return false;
  }

  if (out.channels == 0) out.channels = 2;
  if (out.sampleRate == 0) out.sampleRate = 2822400;

  const size_t ch = out.channels;
  const size_t stride = size_t(blockSize) * ch;
  if (stride == 0 || dataBytes < stride) {
    error = "DSF block layout invalid";
    return false;
  }
  const size_t blocks = dataBytes / stride;
  const size_t usable = blocks * stride;

  // Convert block layout → byte-interleaved, and LSB-first → MSB-first for Harbor FIR / DoP.
  out.interleavedBits.resize(usable);
  size_t o = 0;
  for (size_t b = 0; b < blocks; ++b) {
    const size_t blockBase = dataStart + b * stride;
    for (size_t i = 0; i < blockSize; ++i) {
      for (size_t c = 0; c < ch; ++c) {
        out.interleavedBits[o++] = bitReverse(file[blockBase + c * blockSize + i]);
      }
    }
  }
  return true;
}

bool loadDff(const std::string& path, DsdStream& out, std::string& error) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    error = "Cannot open DFF";
    return false;
  }
  std::vector<uint8_t> file((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  if (file.size() < 32 || std::memcmp(file.data(), "FRM8", 4) != 0) {
    error = "Not a DFF (FRM8) file";
    return false;
  }

  auto be32 = [](const uint8_t* p) {
    return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | uint32_t(p[3]);
  };
  auto be64 = [&](const uint8_t* p) { return (uint64_t(be32(p)) << 32) | uint64_t(be32(p + 4)); };

  out.channels = 2;
  out.sampleRate = 2822400;
  size_t pos = 12;
  if (file.size() > 16 && std::memcmp(file.data() + 12, "DSD ", 4) == 0) pos = 16;

  size_t dsdData = std::string::npos;
  uint64_t dsdBytes = 0;

  while (pos + 12 <= file.size()) {
    const char* id = reinterpret_cast<const char*>(file.data() + pos);
    const uint64_t chunkSize = be64(file.data() + pos + 4);
    const size_t dataStart = pos + 12;
    if (dataStart > file.size()) break;

    if (std::memcmp(id, "PROP", 4) == 0) {
      size_t p = dataStart + 4;
      const size_t pend = dataStart + size_t(std::min(chunkSize, uint64_t(file.size() - dataStart)));
      while (p + 12 <= pend) {
        const char* pid = reinterpret_cast<const char*>(file.data() + p);
        const uint64_t psz = be64(file.data() + p + 4);
        const size_t pd = p + 12;
        if (std::memcmp(pid, "FS  ", 4) == 0 && pd + 4 <= file.size()) {
          out.sampleRate = be32(file.data() + pd);
        } else if (std::memcmp(pid, "CHNL", 4) == 0 && pd + 2 <= file.size()) {
          out.channels = uint16_t((file[pd] << 8) | file[pd + 1]);
        }
        p = pd + size_t(psz);
        if (psz & 1) ++p;
      }
    } else if (std::memcmp(id, "DSD ", 4) == 0) {
      dsdData = dataStart;
      dsdBytes = chunkSize;
      break;
    }

    pos = dataStart + size_t(chunkSize);
    if (chunkSize & 1) ++pos;
  }

  if (dsdData == std::string::npos || dsdData + dsdBytes > file.size()) {
    error = "DFF missing DSD data";
    return false;
  }

  // Keep MSB-first as Harbor FIR expects oldest bit in bit 7.
  out.interleavedBits.assign(file.begin() + static_cast<std::ptrdiff_t>(dsdData),
                             file.begin() + static_cast<std::ptrdiff_t>(dsdData + dsdBytes));
  if (out.channels == 0) out.channels = 2;
  if (out.sampleRate == 0) out.sampleRate = 2822400;
  return true;
}

bool loadDsdFile(const std::string& path, DsdStream& out, std::string& error) {
  auto ends = [&](const char* ext) {
    const size_t n = std::strlen(ext);
    if (path.size() < n) return false;
    for (size_t i = 0; i < n; ++i) {
      if ((path[path.size() - n + i] | 32) != (ext[i] | 32)) return false;
    }
    return true;
  };
  if (ends(".dff")) return loadDff(path, out, error);
  return loadDsf(path, out, error);
}

void packDop(const DsdStream& in, std::vector<int32_t>& pcmOut, uint32_t& pcmSampleRate) {
  pcmSampleRate = in.sampleRate / 16;
  const size_t channels = in.channels ? in.channels : 2;
  const size_t bytesPerChannelFrame = 2;
  const size_t frames = in.interleavedBits.size() / (channels * bytesPerChannelFrame);
  pcmOut.resize(frames * channels);

  bool markerA = true;
  size_t bitPos = 0;
  for (size_t fr = 0; fr < frames; ++fr) {
    const uint8_t marker = markerA ? 0x05 : 0xFA;
    markerA = !markerA;
    for (size_t ch = 0; ch < channels; ++ch) {
      if (bitPos + 1 >= in.interleavedBits.size()) {
        pcmOut[fr * channels + ch] = int32_t(marker) << 24;
        continue;
      }
      const uint8_t b0 = in.interleavedBits[bitPos++];
      const uint8_t b1 = in.interleavedBits[bitPos++];
      const uint32_t payload16 = (uint32_t(b0) << 8) | uint32_t(b1);
      pcmOut[fr * channels + ch] = (int32_t(marker) << 24) | (int32_t(payload16) << 8);
    }
  }
}

void dsdToPcmProgressive(const DsdStream& in, std::vector<float>& pcmInterleaved,
                         uint32_t& outRate, float gainDb, std::atomic<size_t>* readyFrames,
                         std::atomic<bool>* cancel) {
  const size_t channels = in.channels ? in.channels : 2;
  if (readyFrames) readyFrames->store(0, std::memory_order_release);
  if (channels == 0 || in.interleavedBits.empty()) {
    outRate = 88200;
    pcmInterleaved.clear();
    return;
  }

  int decimation = 32;
  if (in.sampleRate >= 11289600) decimation = 128; // DSD256 → ~88.2
  else if (in.sampleRate >= 5644800) decimation = 64; // DSD128 → ~88.2
  outRate = in.sampleRate / uint32_t(decimation);
  if (outRate == 0) outRate = 88200;

  const FirDesign design = makeDesign(in.sampleRate, decimation);
  const int bytesPerPcm = decimation / 8;
  const size_t totalBytes = in.interleavedBits.size();
  const size_t framesPerChannel = totalBytes / (channels * size_t(bytesPerPcm));
  pcmInterleaved.assign(framesPerChannel * channels, 0.0f);
  const float gain = std::pow(10.0f, gainDb / 20.0f);
  const uint8_t* bits = in.interleavedBits.data();

  std::vector<ChannelDecim> chans(channels);
  for (size_t ch = 0; ch < channels; ++ch) {
    chans[ch].ring.assign(size_t(design.stage1Bytes) * 2, 256);
    chans[ch].stages.reserve(design.halfStageTaps.size());
    for (const auto& taps : design.halfStageTaps) chans[ch].stages.emplace_back(taps);
    chans[ch].byteIndex = ch;
  }

  // Timeline order so playback can start after the first second is ready.
  size_t produced = 0;
  for (; produced < framesPerChannel; ++produced) {
    if (cancel && cancel->load(std::memory_order_acquire)) break;
    bool ok = true;
    for (size_t ch = 0; ch < channels; ++ch) {
      float sample = 0.0f;
      if (!feedChannel(chans[ch], design, bits, totalBytes, channels, gain, sample)) {
        ok = false;
        break;
      }
      pcmInterleaved[produced * channels + ch] = sample;
    }
    if (!ok) break;
    if (readyFrames && ((produced + 1) % 4096 == 0)) {
      readyFrames->store(produced + 1, std::memory_order_release);
    }
  }
  if (readyFrames) readyFrames->store(produced, std::memory_order_release);
  (void)bytesPerPcm;
}

void dsdToPcm(const DsdStream& in, std::vector<float>& pcmInterleaved,
              uint32_t& outRate, float gainDb) {
  dsdToPcmProgressive(in, pcmInterleaved, outRate, gainDb, nullptr, nullptr);
}

bool readDsdLayout(const std::string& path, DsdFileLayout& out, std::string& error) {
  out = {};
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    error = "Cannot open DSD file";
    return false;
  }
  std::vector<uint8_t> head(64 * 1024);
  in.read(reinterpret_cast<char*>(head.data()), std::streamsize(head.size()));
  head.resize(size_t(in.gcount()));
  in.clear();
  in.seekg(0, std::ios::end);
  const uint64_t fileSize = uint64_t(in.tellg());

  if (head.size() >= 92 && std::memcmp(head.data(), "DSD ", 4) == 0) {
    // DSF: "DSD " (28 bytes), "fmt " (52), then "data" with a 12-byte header.
    const uint64_t fmt = 28;
    if (std::memcmp(head.data() + fmt, "fmt ", 4) != 0) {
      error = "DSF missing fmt";
      return false;
    }
    const uint8_t* f = head.data() + fmt;
    out.channels = static_cast<uint16_t>(readU32(f + 24));
    out.sampleRate = readU32(f + 28);
    out.lsbFirst = readU32(f + 32) != 8;
    const uint64_t samplesPerChannel = readU64(f + 36);
    out.dsfBlockSize = readU32(f + 44);
    const uint64_t data = fmt + readU64(f + 4);
    if (data + 12 > head.size() || std::memcmp(head.data() + data, "data", 4) != 0 ||
        readU64(head.data() + data + 4) <= 12) {
      error = "DSF missing data";
      return false;
    }
    if (out.channels == 0) out.channels = 2;
    if (out.sampleRate == 0) out.sampleRate = 2822400;
    if (out.dsfBlockSize == 0) out.dsfBlockSize = 4096;
    out.dataStart = data + 12;
    if (out.dataStart >= fileSize) {
      error = "DSF truncated";
      return false;
    }
    const uint64_t dataBytes = std::min(readU64(head.data() + data + 4) - 12, fileSize - out.dataStart);
    const uint64_t stride = uint64_t(out.dsfBlockSize) * out.channels;
    const uint64_t blockBytes = dataBytes / stride * out.dsfBlockSize;
    // The last block is padded; the sample count says where the music stops.
    out.bytesPerChannel = samplesPerChannel > 0 ? std::min(samplesPerChannel / 8, blockBytes) : blockBytes;
    return out.bytesPerChannel > 0;
  }

  if (head.size() >= 16 && std::memcmp(head.data(), "FRM8", 4) == 0) {
    auto be32 = [](const uint8_t* p) {
      return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | uint32_t(p[3]);
    };
    auto be64 = [&](const uint8_t* p) { return (uint64_t(be32(p)) << 32) | uint64_t(be32(p + 4)); };
    uint64_t pos = 16;
    while (pos + 12 <= fileSize) {
      uint8_t chunk[12];
      in.clear();
      in.seekg(std::streamoff(pos));
      if (!in.read(reinterpret_cast<char*>(chunk), 12)) break;
      const uint64_t size = be64(chunk + 4);
      const uint64_t body = pos + 12;
      if (std::memcmp(chunk, "PROP", 4) == 0) {
        std::vector<uint8_t> prop(size_t(std::min<uint64_t>(size, 1 << 20)));
        in.read(reinterpret_cast<char*>(prop.data()), std::streamsize(prop.size()));
        size_t p = 4; // "SND "
        while (p + 12 <= prop.size()) {
          const uint64_t sub = be64(prop.data() + p + 4);
          const size_t subBody = p + 12;
          if (std::memcmp(prop.data() + p, "FS  ", 4) == 0 && subBody + 4 <= prop.size()) {
            out.sampleRate = be32(prop.data() + subBody);
          } else if (std::memcmp(prop.data() + p, "CHNL", 4) == 0 && subBody + 2 <= prop.size()) {
            out.channels = uint16_t((prop[subBody] << 8) | prop[subBody + 1]);
          } else if (std::memcmp(prop.data() + p, "CMPR", 4) == 0 && subBody + 4 <= prop.size() &&
                     std::memcmp(prop.data() + subBody, "DSD ", 4) != 0) {
            error = "DST-compressed DFF is not supported";
            return false;
          }
          p = subBody + size_t(sub) + size_t(sub & 1);
        }
      } else if (std::memcmp(chunk, "DSD ", 4) == 0) {
        if (out.channels == 0) out.channels = 2;
        if (out.sampleRate == 0) out.sampleRate = 2822400;
        out.dataStart = body;
        out.bytesPerChannel = std::min(size, fileSize - body) / out.channels;
        return out.bytesPerChannel > 0;
      } else if (std::memcmp(chunk, "DST ", 4) == 0) {
        error = "DST-compressed DFF is not supported";
        return false;
      }
      pos = body + size + (size & 1);
    }
    error = "DFF missing DSD data";
    return false;
  }

  error = "Not a DSF or DFF file";
  return false;
}

struct DsdByteReader::Impl {
  std::FILE* file = nullptr;
  DsdFileLayout layout;
  size_t chunkBytes = 64 * 1024;
  std::vector<std::vector<uint8_t>> chunk; // per channel, MSB-first
  uint64_t chunkStart = 0;
  size_t chunkLength = 0;
  std::vector<uint8_t> raw;
  uint8_t reverse[256];

  ~Impl() {
    if (file) std::fclose(file);
  }

  bool seekFile(uint64_t offset) {
#if defined(_WIN32)
    return _fseeki64(file, int64_t(offset), SEEK_SET) == 0;
#else
    return fseeko(file, off_t(offset), SEEK_SET) == 0;
#endif
  }

  /** Loads the chunk holding DSD byte `index` (per channel). */
  bool load(uint64_t index) {
    const size_t channels = layout.channels;
    if (index >= layout.bytesPerChannel) return false;
    uint64_t start = index;
    uint64_t offset = 0;
    if (layout.dsfBlockSize > 0) {
      const uint64_t block = index / layout.dsfBlockSize;
      start = block * layout.dsfBlockSize;
      offset = layout.dataStart + block * layout.dsfBlockSize * channels;
    } else {
      offset = layout.dataStart + start * channels;
    }
    const size_t length = size_t(std::min<uint64_t>(chunkBytes, layout.bytesPerChannel - start));
    if (layout.dsfBlockSize > 0) {
      // Whole blocks: the file has channel 0's block, then channel 1's, …
      const size_t bs = layout.dsfBlockSize;
      const size_t blocks = (length + bs - 1) / bs;
      raw.resize(blocks * bs * channels);
      if (!seekFile(offset)) return false;
      const size_t got = std::fread(raw.data(), 1, raw.size(), file);
      if (got < raw.size()) std::memset(raw.data() + got, 0, raw.size() - got);
      for (size_t c = 0; c < channels; ++c) {
        uint8_t* dst = chunk[c].data();
        for (size_t b = 0; b < blocks; ++b) {
          const uint8_t* src = raw.data() + (b * channels + c) * bs;
          const size_t n = std::min(bs, length - b * bs);
          if (layout.lsbFirst) {
            for (size_t i = 0; i < n; ++i) dst[b * bs + i] = reverse[src[i]];
          } else {
            std::memcpy(dst + b * bs, src, n);
          }
        }
      }
    } else {
      raw.resize(length * channels);
      if (!seekFile(offset)) return false;
      const size_t got = std::fread(raw.data(), 1, raw.size(), file);
      if (got < raw.size()) std::memset(raw.data() + got, 0, raw.size() - got);
      for (size_t i = 0; i < length; ++i) {
        for (size_t c = 0; c < channels; ++c) chunk[c][i] = raw[i * channels + c];
      }
    }
    chunkStart = start;
    chunkLength = length;
    return true;
  }
};

DsdByteReader::DsdByteReader() : impl_(std::make_unique<Impl>()) {}
DsdByteReader::~DsdByteReader() = default;

bool DsdByteReader::open(const std::string& path, std::string& error) {
  auto& s = *impl_;
  if (!readDsdLayout(path, s.layout, error)) return false;
  s.file = std::fopen(path.c_str(), "rb");
  if (!s.file) {
    error = "Cannot open DSD file";
    return false;
  }
  for (int b = 0; b < 256; ++b) s.reverse[b] = bitReverse(uint8_t(b));
  s.chunkBytes = std::max<size_t>(64 * 1024, s.layout.dsfBlockSize);
  s.chunk.assign(s.layout.channels, std::vector<uint8_t>(s.chunkBytes));
  s.chunkLength = 0;
  return true;
}

const DsdFileLayout& DsdByteReader::layout() const { return impl_->layout; }

size_t DsdByteReader::ensure(uint64_t index, size_t count) {
  auto& s = *impl_;
  if (!s.file || count == 0 || index + count > s.layout.bytesPerChannel) return 0;
  const auto inChunk = [&] { return index >= s.chunkStart && index + count <= s.chunkStart + s.chunkLength; };
  if (!inChunk() && !(s.load(index) && inChunk())) return 0;
  return size_t(s.chunkStart + s.chunkLength - index);
}

const uint8_t* DsdByteReader::at(uint16_t channel, uint64_t index) const {
  return impl_->chunk[channel].data() + (index - impl_->chunkStart);
}

struct DsdPcmReader::Impl {
  DsdByteReader bytes;
  FirDesign design;
  int bytesPerFrame = 4; // DSD bytes per channel for one output frame
  uint32_t outRate = 88200;
  uint64_t frames = 0;
  uint64_t settleFrames = 0;
  float gain = 1.0f;
  std::vector<ChannelDecim> chans;
  uint64_t nextFrame = UINT64_MAX; // where the filter state stands
  uint64_t cursor = 0;             // next DSD byte per channel

  void reset(uint64_t frame) {
    for (auto& ch : chans) {
      ch.ring.assign(size_t(design.stage1Bytes) * 2, 256);
      ch.byteWrite = 0;
      ch.stages.clear();
      for (const auto& taps : design.halfStageTaps) ch.stages.emplace_back(taps);
    }
    cursor = frame * uint64_t(bytesPerFrame);
    nextFrame = frame;
  }

  static float push(ChannelDecim& ch, const FirDesign& design, uint8_t b, bool& have) {
    const int length = design.stage1Bytes;
    ch.ring[size_t(ch.byteWrite)] = b;
    ch.ring[size_t(ch.byteWrite + length)] = b;
    ch.byteWrite = ch.byteWrite + 1 == length ? 0 : ch.byteWrite + 1;
    float value = 0.0f;
    const uint16_t* ring = ch.ring.data() + ch.byteWrite;
    const float* table = design.stage1Table.data();
    for (int j = 0; j < length; ++j) value += table[size_t(j * 257 + ring[j])];
    for (auto& stage : ch.stages) {
      float* o = stage.push(value);
      if (!o) {
        have = false;
        return 0.0f;
      }
      value = *o;
    }
    have = true;
    return value;
  }

  /** One output frame into out (nullptr = discard). False at the end of the data. */
  bool produce(float* out) {
    if (nextFrame >= frames || bytes.ensure(cursor, size_t(bytesPerFrame)) == 0) return false;
    for (size_t c = 0; c < chans.size(); ++c) {
      const uint8_t* data = bytes.at(uint16_t(c), cursor);
      float value = 0.0f;
      bool have = false;
      for (int k = 0; k < bytesPerFrame; ++k) value = push(chans[c], design, data[k], have);
      if (out) {
        value *= gain;
        if (value > 1.0f) value = 1.0f;
        if (value < -1.0f) value = -1.0f;
        out[c] = have ? value : 0.0f;
      }
    }
    cursor += uint64_t(bytesPerFrame);
    ++nextFrame;
    return true;
  }
};

DsdPcmReader::DsdPcmReader() : impl_(std::make_unique<Impl>()) {}
DsdPcmReader::~DsdPcmReader() = default;

bool DsdPcmReader::open(const std::string& path, float gainDb, bool halfRate, std::string& error) {
  auto& s = *impl_;
  if (!s.bytes.open(path, error)) return false;
  const DsdFileLayout& layout = s.bytes.layout();
  int decimation = 32;
  if (layout.sampleRate >= 11289600) decimation = 128; // DSD256 → ~88.2
  else if (layout.sampleRate >= 5644800) decimation = 64; // DSD128 → ~88.2
  if (halfRate) decimation *= 2;
  s.design = makeDesign(layout.sampleRate, decimation, halfRate ? 20000.0 : 0.0);
  s.bytesPerFrame = decimation / 8;
  s.outRate = layout.sampleRate / uint32_t(decimation);
  s.frames = layout.bytesPerChannel / uint64_t(s.bytesPerFrame);
  s.gain = std::pow(10.0f, gainDb / 20.0f);

  // Frames until fresh filter state matches continuous play: every stage's length in output
  // frames, plus a margin.
  uint64_t settle = uint64_t((s.design.stage1Bytes + s.bytesPerFrame - 1) / s.bytesPerFrame);
  const size_t halfStages = s.design.halfStageTaps.size();
  for (size_t i = 0; i < halfStages; ++i) {
    const uint64_t inputsPerFrame = uint64_t(1) << (halfStages - i);
    settle += (uint64_t(s.design.halfStageTaps[i].size()) + inputsPerFrame - 1) / inputsPerFrame;
  }
  s.settleFrames = settle + 8;

  s.chans.assign(layout.channels, ChannelDecim {});
  s.reset(0);
  return s.frames > 0;
}

uint32_t DsdPcmReader::sampleRate() const { return impl_->outRate; }
uint16_t DsdPcmReader::channels() const { return impl_->bytes.layout().channels; }
uint64_t DsdPcmReader::frameCount() const { return impl_->frames; }

size_t DsdPcmReader::read(uint64_t startFrame, size_t count, float* out) {
  auto& s = *impl_;
  if (startFrame >= s.frames) return 0;
  count = size_t(std::min<uint64_t>(count, s.frames - startFrame));
  if (startFrame != s.nextFrame) {
    s.reset(startFrame > s.settleFrames ? startFrame - s.settleFrames : 0);
    while (s.nextFrame < startFrame) {
      if (!s.produce(nullptr)) return 0;
    }
  }
  const size_t channels = s.chans.size();
  size_t written = 0;
  while (written < count && s.produce(out + written * channels)) ++written;
  return written;
}
