#include "DsdPipeline.h"

#include <cmath>
#include <cstring>
#include <fstream>

namespace {

uint32_t readU32(const uint8_t* p) {
  return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}

uint64_t readU64(const uint8_t* p) {
  return uint64_t(readU32(p)) | (uint64_t(readU32(p + 4)) << 32);
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

  // Find fmt chunk
  size_t pos = 28; // after DSD chunk header typically
  // Scan for "fmt "
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
  const uint32_t bitsPerSample = readU32(f + 32); // usually 1
  const uint64_t sampleCount = readU64(f + 36);
  (void)bitsPerSample;

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

  out.interleavedBits.assign(file.begin() + static_cast<std::ptrdiff_t>(dataStart),
                             file.begin() + static_cast<std::ptrdiff_t>(dataStart + dataBytes));
  if (out.channels == 0) out.channels = 2;
  if (out.sampleRate == 0) out.sampleRate = 2822400;
  (void)sampleCount;
  (void)pos;
  return true;
}

void packDop(const DsdStream& in, std::vector<int32_t>& pcmOut, uint32_t& pcmSampleRate) {
  // DoP: 16 DSD bits per 24-bit word + marker in top byte alternating 0x05 / 0xFA
  // PCM rate = DSD rate / 16
  pcmSampleRate = in.sampleRate / 16;
  const size_t channels = in.channels ? in.channels : 2;
  const size_t bytesPerChannelFrame = 2; // 16 bits = 2 bytes per DoP frame per channel
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
      // DSF: channel-interleaved bytes; take 2 bytes = 16 bits
      const uint8_t b0 = in.interleavedBits[bitPos++];
      const uint8_t b1 = in.interleavedBits[bitPos++];
      // Harbor: oldest DSD bit in bit 15 of the 16-bit payload (high of 24-bit word)
      const uint32_t payload16 = (uint32_t(b0) << 8) | uint32_t(b1);
      const int32_t word = (int32_t(marker) << 24) | (int32_t(payload16) << 8);
      pcmOut[fr * channels + ch] = word;
    }
  }
}

void dsdToPcm(const DsdStream& in, std::vector<float>& pcmInterleaved,
              uint32_t& outRate, float gainDb) {
  // Decimate DSD64 (2.8224 MHz) → 88.2 kHz = factor 32
  const uint32_t factor = 32;
  outRate = in.sampleRate / factor;
  const size_t channels = in.channels ? in.channels : 2;
  const size_t totalBits = in.interleavedBits.size() * 8;
  const size_t frames = totalBits / (channels * factor);
  pcmInterleaved.assign(frames * channels, 0.0f);
  const float gain = std::pow(10.0f, gainDb / 20.0f);

  // Per-channel running average of `factor` bits
  for (size_t fr = 0; fr < frames; ++fr) {
    for (size_t ch = 0; ch < channels; ++ch) {
      int sum = 0;
      for (size_t i = 0; i < factor; ++i) {
        const size_t bitIndex = (fr * factor + i) * channels + ch;
        const size_t byteIndex = bitIndex / 8;
        const size_t bitInByte = bitIndex % 8;
        if (byteIndex >= in.interleavedBits.size()) break;
        const uint8_t byte = in.interleavedBits[byteIndex];
        // DSF LSB-first
        const int bit = (byte >> bitInByte) & 1;
        sum += bit ? 1 : -1;
      }
      float s = (float(sum) / float(factor)) * gain;
      if (s > 1.0f) s = 1.0f;
      if (s < -1.0f) s = -1.0f;
      pcmInterleaved[fr * channels + ch] = s;
    }
  }
}
