#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

class ALACDecoder;

/**
 * Apple Lossless in an MP4 / M4A file, decoded natively (Apple's open-source decoder in
 * third_party/alac): the container's sample tables give each packet's place in the file and its
 * first frame, so any frame is reached by decoding one packet — a few KB in memory, not the track.
 * Not thread-safe.
 */
class AlacReader {
public:
  AlacReader();
  ~AlacReader();
  AlacReader(const AlacReader&) = delete;
  AlacReader& operator=(const AlacReader&) = delete;

  /**
   * Opens `path`. False with `notAlac` set when the file is readable MP4 but its audio is another
   * codec (AAC): the caller may hand it to another decoder. Otherwise `error` says what is wrong.
   */
  bool open(const std::string& path, std::string& error, bool& notAlac);

  uint32_t sampleRate() const { return sampleRate_; }
  uint16_t channels() const { return channels_; }
  uint64_t frameCount() const { return frameCount_; }
  /** As stored: 16, 20, 24 or 32. */
  uint16_t bitDepth() const { return bitDepth_; }

  /**
   * Interleaved samples, left-justified in 32 bits (a 16-bit sample in the top 16 bits), from
   * `startFrame` on. Returns the frames written: fewer at the end, 0 on a read or decode error.
   */
  size_t readS32(uint64_t startFrame, size_t count, int32_t* out);

private:
  bool decodePacket(size_t index);

  std::FILE* file_ = nullptr;
  std::unique_ptr<ALACDecoder> decoder_;
  uint32_t sampleRate_ = 0;
  uint16_t channels_ = 0;
  uint16_t bitDepth_ = 0;
  uint32_t frameLength_ = 0;
  uint64_t frameCount_ = 0;

  /** Per packet: where it is, how many bytes, its first frame. */
  std::vector<uint64_t> offsets_;
  std::vector<uint32_t> sizes_;
  std::vector<uint64_t> starts_;

  /** The packet decoded last, left-justified; reused while reads stay inside it. */
  size_t current_ = SIZE_MAX;
  size_t currentFrames_ = 0;
  std::vector<int32_t> pcm_;
  std::vector<uint8_t> packet_;
  std::vector<uint8_t> raw_;
};
