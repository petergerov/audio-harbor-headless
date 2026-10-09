#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
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

/** Where the DSD bytes of a DSF / DFF file are — read from the header only. */
struct DsdFileLayout {
  uint32_t sampleRate = 2822400;
  uint16_t channels = 2;
  uint64_t dataStart = 0;       // file offset of the first DSD byte
  uint64_t bytesPerChannel = 0; // 8 DSD samples per byte
  uint32_t dsfBlockSize = 0;    // DSF: per-channel block; 0 = DFF, byte-interleaved
  bool lsbFirst = false;        // DSF 1-bit: oldest sample in bit 0
};

bool readDsdLayout(const std::string& path, DsdFileLayout& out, std::string& error);

/**
 * DSD → PCM with random access, for streaming to a network player. Reads the file in chunks
 * instead of loading it, uses the same FIR design as dsdToPcm, and pre-rolls after a jump so
 * a seek yields the same samples as continuous conversion. Not thread-safe.
 */
class DsdPcmReader {
public:
  DsdPcmReader();
  ~DsdPcmReader();
  DsdPcmReader(const DsdPcmReader&) = delete;
  DsdPcmReader& operator=(const DsdPcmReader&) = delete;

  /** halfRate adds one 2:1 stage with a 20 kHz passband: 44.1 kHz for DSD64…256. */
  bool open(const std::string& path, float gainDb, bool halfRate, std::string& error);
  uint32_t sampleRate() const;
  uint16_t channels() const;
  uint64_t frameCount() const;
  /** Interleaved float frames [startFrame, startFrame + count); returns the frames written. */
  size_t read(uint64_t startFrame, size_t count, float* out);

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
