#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

/**
 * DSD that came in as DoP, written as a native DSF: the 16 DSD bits each DoP frame carries per
 * channel, unchanged (bit order turned to DSF's LSB-first), in 4096-byte blocks per channel.
 */
class DsfWriter {
public:
  ~DsfWriter();
  /** dsdRate: 2822400 for DSD64 (DoP carrier 176.4 kHz × 16). */
  bool open(const std::string& path, uint32_t dsdRate, int channels, std::string& error);
  /** DoP frames, left-justified 32-bit: marker in the top byte, then two DSD bytes. */
  bool writeDop(const int32_t* interleaved, size_t frames);
  bool close();
  uint64_t dsdBytesPerChannel() const { return bytes_; }

private:
  bool flushBlock();
  bool writeHeader();
  FILE* file_ = nullptr;
  uint32_t rate_ = 0;
  int channels_ = 0;
  std::vector<std::vector<uint8_t>> block_;
  size_t fill_ = 0;
  uint64_t bytes_ = 0;
  uint64_t blocks_ = 0;
  bool failed_ = false;
};
