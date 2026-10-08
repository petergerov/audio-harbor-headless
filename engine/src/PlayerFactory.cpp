#include "HarborEngine.h"
#include "Player.h"

#include <cstring>
#include <mutex>
#include <string>

#if defined(HARBOR_WITH_JUCE)
IPlayer* createJucePlayer();
#endif
#if defined(__APPLE__)
IPlayer* createMacPlayer();
#endif
#if defined(__linux__)
IPlayer* createLinuxPlayer();
#endif
#if defined(_WIN32)
IPlayer* createWinPlayer();
#endif
IPlayer* createStubPlayer();

namespace {

std::mutex g_factoryMutex;
HarborAudioBackend g_requested = HARBOR_BACKEND_AUTO;
HarborAudioBackend g_effective = HARBOR_BACKEND_AUTO;

HarborAudioBackend resolveBackend(HarborAudioBackend requested) {
  if (requested == HARBOR_BACKEND_JUCE) {
#if defined(HARBOR_WITH_JUCE)
    return HARBOR_BACKEND_JUCE;
#endif
  }
  if (requested == HARBOR_BACKEND_NATIVE) {
#if defined(__APPLE__) || defined(__linux__) || defined(_WIN32)
    return HARBOR_BACKEND_NATIVE;
#elif defined(HARBOR_WITH_JUCE)
    return HARBOR_BACKEND_JUCE;
#endif
  }
  // auto: prefer native Exclusive/DoP stacks everywhere they exist
#if defined(__APPLE__) || defined(__linux__) || defined(_WIN32)
  return HARBOR_BACKEND_NATIVE;
#elif defined(HARBOR_WITH_JUCE)
  return HARBOR_BACKEND_JUCE;
#else
  return HARBOR_BACKEND_AUTO;
#endif
}

IPlayer* makePlayer(HarborAudioBackend backend) {
  if (backend == HARBOR_BACKEND_JUCE) {
#if defined(HARBOR_WITH_JUCE)
    return createJucePlayer();
#endif
  }
  if (backend == HARBOR_BACKEND_NATIVE) {
#if defined(__APPLE__)
    return createMacPlayer();
#elif defined(__linux__)
    return createLinuxPlayer();
#elif defined(_WIN32)
    return createWinPlayer();
#endif
  }
#if defined(HARBOR_WITH_JUCE)
  return createJucePlayer();
#elif defined(__APPLE__)
  return createMacPlayer();
#elif defined(__linux__)
  return createLinuxPlayer();
#elif defined(_WIN32)
  return createWinPlayer();
#else
  return createStubPlayer();
#endif
}

} // namespace

void harbor_player_factory_set_requested(HarborAudioBackend backend) {
  std::lock_guard lock(g_factoryMutex);
  g_requested = backend;
  g_effective = resolveBackend(g_requested);
}

HarborAudioBackend harbor_player_factory_requested() {
  std::lock_guard lock(g_factoryMutex);
  return g_requested;
}

HarborAudioBackend harbor_player_factory_effective() {
  std::lock_guard lock(g_factoryMutex);
  return g_effective;
}

IPlayer* createHarborPlayer() {
  std::lock_guard lock(g_factoryMutex);
  g_effective = resolveBackend(g_requested);
  return makePlayer(g_effective);
}

int harbor_engine_list_audio_backends(char* out, size_t out_len) {
  if (!out || out_len == 0) return -1;
  std::string list = "auto";
#if defined(HARBOR_WITH_JUCE)
  list += ",juce";
#endif
#if defined(__APPLE__) || defined(__linux__) || defined(_WIN32)
  list += ",native";
#endif
  if (list.size() >= out_len) return -1;
  std::memcpy(out, list.c_str(), list.size() + 1);
  return 0;
}

const char* harbor_engine_audio_backend_name(HarborAudioBackend backend) {
  switch (backend) {
    case HARBOR_BACKEND_JUCE: return "juce";
    case HARBOR_BACKEND_NATIVE: return "native";
    default: return "auto";
  }
}

HarborAudioBackend harbor_engine_get_audio_backend(void) {
  return harbor_player_factory_effective();
}

HarborAudioBackend harbor_engine_get_requested_audio_backend(void) {
  return harbor_player_factory_requested();
}
