#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

/** What an S/PDIF stream carries. */
enum class RecordContent { Pcm = 0, Dop = 1, Bitstream = 2 };

const char* recordContentName(RecordContent c);

struct RecordSegment {
  uint64_t start;
  uint64_t end; // exclusive
  RecordContent content;
};

struct SilenceRun {
  uint64_t start;
  uint64_t end; // exclusive
};

/**
 * Reads a captured stream (left-justified 32-bit, interleaved) and finds what it is, frame-exact:
 * PCM, DSD as DoP (alternating 0x05 / 0xFA markers on all channels), or an IEC 61937 bitstream
 * (Dolby / DTS: sync words 0xF872 0x4E1F). Also silence runs, the bits in use, and peaks.
 * The same code runs live (for the remote) and over the finished take (to cut the files).
 */
class StreamAnalyzer {
public:
  /** keepBlockMasks: remember the bits used per 1024 frames, for the 16 / 24-bit decision. */
  StreamAnalyzer(int channels, uint32_t rate, double silenceDb, double silenceSeconds, bool keepBlockMasks);

  void feed(const int32_t* interleaved, size_t frames);
  /** Closes the open segment and silence run at the end of the stream. */
  void finish();

  const std::vector<RecordSegment>& segments() const { return segments_; }
  const std::vector<SilenceRun>& silences() const { return silences_; }
  /** OR of all samples per block of kMaskBlock frames. */
  const std::vector<uint32_t>& blockMasks() const { return blockMasks_; }
  static constexpr uint32_t kMaskBlock = 1024;

  uint64_t frames() const { return pos_; }
  RecordContent current() const { return mode_; }
  /** Bits the PCM used in the last full second: 0 (digital silence), 16, 24 or 32. */
  int recentBits() const { return recentBits_; }
  /** Below the silence threshold for at least half a second. */
  bool silent() const;
  /** Peak per channel since the last call, 0…1. */
  void takePeaks(float* out, int maxChannels);

private:
  void switchTo(RecordContent content, uint64_t at);
  void endSilence(uint64_t at);

  int channels_;
  uint32_t rate_;
  uint32_t threshold_;
  uint64_t minSilence_;
  bool keepMasks_;
  uint64_t pos_ = 0;

  RecordContent mode_ = RecordContent::Pcm;
  std::vector<RecordSegment> segments_;
  uint64_t segmentStart_ = 0;

  // DoP
  uint8_t lastMarker_ = 0;
  uint32_t dopRun_ = 0;
  uint64_t dopRunStart_ = 0;
  uint32_t dopBad_ = 0;
  uint64_t dopBadStart_ = 0;

  // IEC 61937
  bool haveSync_ = false;
  uint64_t lastSync_ = 0;
  uint64_t syncPeriod_ = 0;

  // Silence, in 10 ms windows
  uint32_t window_;
  uint32_t windowFill_ = 0;
  uint32_t windowPeak_ = 0;
  bool inSilence_ = false;
  uint64_t silenceStart_ = 0;
  std::vector<SilenceRun> silences_;

  // Bits
  std::vector<uint32_t> blockMasks_;
  uint32_t blockMask_ = 0;
  uint32_t blockFill_ = 0;
  uint32_t secondMask_ = 0;
  uint32_t secondFill_ = 0;
  int recentBits_ = 0;

  std::vector<uint32_t> peaks_;
};
