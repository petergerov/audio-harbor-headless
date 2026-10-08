#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct DecodedPcm {
  uint32_t sampleRate = 44100;
  uint16_t channels = 2;
  std::vector<float> interleaved;
};

/** Decode WAV / FLAC / MP3 to interleaved float PCM. */
bool decodePcmFile(const std::string& path, DecodedPcm& out, std::string& error);
