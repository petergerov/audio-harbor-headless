#include "DsdPipeline.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <vector>

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

FirDesign makeDesign(uint32_t dsdRate, int decimation) {
  FirDesign d;
  d.decimation = decimation;
  const double outRate = double(dsdRate) / double(decimation);
  const int halfStages = std::max(1, int(std::lround(std::log2(double(decimation / 8)))));
  const double passband = std::min(25000.0, outRate * 0.3);
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
    static thread_local float out;
    out = sum;
    return &out;
  }
};

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

  // Normalize DSF LSB-first → MSB-first (oldest bit in bit 7), matching DFF / Harbor FIR.
  out.interleavedBits.resize(dataBytes);
  for (size_t i = 0; i < dataBytes; ++i) {
    out.interleavedBits[i] = bitReverse(file[dataStart + i]);
  }
  if (out.channels == 0) out.channels = 2;
  if (out.sampleRate == 0) out.sampleRate = 2822400;
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

void dsdToPcm(const DsdStream& in, std::vector<float>& pcmInterleaved,
              uint32_t& outRate, float gainDb) {
  const size_t channels = in.channels ? in.channels : 2;
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

  // Process per channel. Bits are channel-interleaved by byte for DSF.
  for (size_t ch = 0; ch < channels; ++ch) {
    std::vector<uint16_t> ring(size_t(design.stage1Bytes) * 2, 256);
    int byteWrite = 0;
    std::vector<HalfDecimator> stages;
    stages.reserve(design.halfStageTaps.size());
    for (const auto& taps : design.halfStageTaps) stages.emplace_back(taps);

    size_t outFrame = 0;
    size_t byteIndex = ch; // interleaved
    while (byteIndex < totalBytes && outFrame < framesPerChannel) {
      const uint8_t b = in.interleavedBits[byteIndex];
      const int length = design.stage1Bytes;
      ring[size_t(byteWrite)] = b;
      ring[size_t(byteWrite + length)] = b;
      byteWrite = byteWrite + 1 == length ? 0 : byteWrite + 1;

      float value = 0.0f;
      const int start = byteWrite;
      for (int j = 0; j < length; ++j) {
        const uint16_t wb = ring[size_t(start + j)];
        if (wb > 255) continue;
        value += design.stage1Table[size_t(j * 257 + int(wb))];
      }

      bool have = true;
      for (auto& stage : stages) {
        float* o = stage.push(value);
        if (!o) {
          have = false;
          break;
        }
        value = *o;
      }

      if (have) {
        value *= gain;
        if (value > 1.0f) value = 1.0f;
        if (value < -1.0f) value = -1.0f;
        pcmInterleaved[outFrame * channels + ch] = value;
        ++outFrame;
      }

      byteIndex += channels;
    }
  }
  (void)bytesPerPcm;
}
