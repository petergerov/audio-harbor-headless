#include "DsfWriter.h"

#include <algorithm>
namespace {

constexpr size_t kBlock = 4096;
constexpr uint64_t kHeaderBytes = 28 + 52 + 12;

uint8_t reverseBits(uint8_t b) {
  b = uint8_t((b & 0xF0) >> 4 | (b & 0x0F) << 4);
  b = uint8_t((b & 0xCC) >> 2 | (b & 0x33) << 2);
  b = uint8_t((b & 0xAA) >> 1 | (b & 0x55) << 1);
  return b;
}

void put32(std::vector<uint8_t>& o, uint32_t v) {
  for (int i = 0; i < 4; ++i) o.push_back(uint8_t(v >> (8 * i)));
}
void put64(std::vector<uint8_t>& o, uint64_t v) {
  for (int i = 0; i < 8; ++i) o.push_back(uint8_t(v >> (8 * i)));
}
void tag(std::vector<uint8_t>& o, const char* t) { o.insert(o.end(), t, t + 4); }

} // namespace

DsfWriter::~DsfWriter() {
  if (file_) std::fclose(file_);
}

bool DsfWriter::open(const std::string& path, uint32_t dsdRate, int channels, std::string& error) {
  if (channels < 1 || channels > 6) {
    error = "Unsupported DSF channel count";
    return false;
  }
  file_ = std::fopen(path.c_str(), "wb");
  if (!file_) {
    error = "Cannot create " + path;
    return false;
  }
  std::setvbuf(file_, nullptr, _IOFBF, 1 << 20);
  rate_ = dsdRate;
  channels_ = channels;
  block_.assign(size_t(channels), std::vector<uint8_t>(kBlock, 0));
  if (!writeHeader()) {
    error = "Cannot write " + path;
    return false;
  }
  return true;
}

bool DsfWriter::writeHeader() {
  const uint64_t dataBytes = blocks_ * kBlock * uint64_t(channels_);
  std::vector<uint8_t> h;
  tag(h, "DSD ");
  put64(h, 28);
  put64(h, kHeaderBytes + dataBytes);
  put64(h, 0); // no ID3 metadata
  tag(h, "fmt ");
  put64(h, 52);
  put32(h, 1);  // format version
  put32(h, 0);  // DSD raw
  static const uint32_t kChannelType[7] = {0, 1, 2, 3, 4, 6, 7}; // mono, stereo, 3ch, quad, 5ch, 5.1
  put32(h, kChannelType[channels_]);
  put32(h, uint32_t(channels_));
  put32(h, rate_);
  put32(h, 1); // bits per sample
  put64(h, bytes_ * 8);
  put32(h, uint32_t(kBlock));
  put32(h, 0);
  tag(h, "data");
  put64(h, 12 + dataBytes);
  if (std::fseek(file_, 0, SEEK_SET) != 0) return false;
  if (std::fwrite(h.data(), 1, h.size(), file_) != h.size()) return false;
  return std::fseek(file_, 0, SEEK_END) == 0;
}

bool DsfWriter::flushBlock() {
  for (int c = 0; c < channels_; ++c) {
    if (std::fwrite(block_[size_t(c)].data(), 1, kBlock, file_) != kBlock) {
      failed_ = true;
      return false;
    }
    std::fill(block_[size_t(c)].begin(), block_[size_t(c)].end(), 0);
  }
  ++blocks_;
  fill_ = 0;
  return true;
}

bool DsfWriter::writeDop(const int32_t* interleaved, size_t frames) {
  if (!file_ || failed_) return false;
  for (size_t f = 0; f < frames; ++f) {
    for (int c = 0; c < channels_; ++c) {
      const uint32_t s = uint32_t(interleaved[f * size_t(channels_) + size_t(c)]);
      block_[size_t(c)][fill_] = reverseBits(uint8_t(s >> 16));
      block_[size_t(c)][fill_ + 1] = reverseBits(uint8_t(s >> 8));
    }
    fill_ += 2;
    bytes_ += 2;
    if (fill_ == kBlock && !flushBlock()) return false;
  }
  return true;
}

bool DsfWriter::close() {
  if (!file_) return false;
  bool ok = !failed_;
  if (ok && fill_ > 0) ok = flushBlock();
  if (ok) ok = writeHeader();
  if (std::fclose(file_) != 0) ok = false;
  file_ = nullptr;
  return ok;
}
