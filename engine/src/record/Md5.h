#pragma once

#include <stddef.h>
#include <stdint.h>

/** MD5 (RFC 1321) for the FLAC STREAMINFO signature of the audio. */
class Md5 {
public:
  Md5();
  void update(const void* data, size_t len);
  void finish(uint8_t out[16]);

private:
  void block(const uint8_t* p);
  uint32_t h_[4];
  uint64_t length_ = 0;
  uint8_t buffer_[64];
  size_t used_ = 0;
};
