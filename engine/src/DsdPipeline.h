#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct DsdStream {
  uint32_t sampleRate = 2822400; // DSD64
  uint16_t channels = 2;
  std::vector<uint8_t> interleavedBits; // LSB-first DSF convention per byte
};

/** Load a DSF file into interleaved 1-bit samples (basic DSD64 stereo). */
bool loadDsf(const std::string& path, DsdStream& out, std::string& error);

/** Pack DSD bits into DoP PCM frames (24-bit in 32-bit words, marker 0x05/0xFA). */
void packDop(const DsdStream& in, std::vector<int32_t>& pcmOut, uint32_t& pcmSampleRate);

/**
 * Simple multi-stage boxcar-ish decimation to ~88.2 kHz float PCM.
 * Not Harbor FIR parity yet — linear phase placeholder with gain.
 */
void dsdToPcm(const DsdStream& in, std::vector<float>& pcmInterleaved,
              uint32_t& outRate, float gainDb);
