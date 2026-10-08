#pragma once

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

struct DsdStream {
  uint32_t sampleRate = 2822400; // DSD64
  uint16_t channels = 2;
  std::vector<uint8_t> interleavedBits; // LSB-first DSF convention per byte
};

/** Load a DSF file into interleaved 1-bit samples (LSB-first bytes). */
bool loadDsf(const std::string& path, DsdStream& out, std::string& error);

/** Load a DSDIFF (.dff) file into interleaved 1-bit samples. */
bool loadDff(const std::string& path, DsdStream& out, std::string& error);

/** Load DSF or DFF by extension. */
bool loadDsdFile(const std::string& path, DsdStream& out, std::string& error);

/** Pack DSD bits into DoP PCM frames (24-bit in 32-bit words, marker 0x05/0xFA). */
void packDop(const DsdStream& in, std::vector<int32_t>& pcmOut, uint32_t& pcmSampleRate);

/**
 * Multi-stage CIC-style decimation to ~88.2 kHz float PCM + gain.
 * Better stopband than plain boxcar; full Harbor FIR still follow-up.
 */
void dsdToPcm(const DsdStream& in, std::vector<float>& pcmInterleaved,
              uint32_t& outRate, float gainDb);

/**
 * Same conversion as dsdToPcm, but fills pcmInterleaved in timeline order and
 * publishes ready frame count so playback can start before the whole track is done.
 * If cancel becomes true, stops early (partial pcm remains valid up to readyFrames).
 */
void dsdToPcmProgressive(
    const DsdStream& in, std::vector<float>& pcmInterleaved, uint32_t& outRate, float gainDb,
    std::atomic<size_t>* readyFrames, std::atomic<bool>* cancel);
