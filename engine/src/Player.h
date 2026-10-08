#pragma once

#include "HarborEngine.h"
#include <functional>
#include <mutex>
#include <string>
#include <vector>

struct PlayerDevice {
  std::string uid;
  std::string name;
  bool isExternal = false;
  bool supportsExclusive = false;
  bool supportsDop = false;
};

class IPlayer {
public:
  using EventFn = std::function<void(const char* event, const char* json)>;

  virtual ~IPlayer() = default;
  virtual std::vector<PlayerDevice> listDevices() = 0;
  virtual void setDevice(const std::string* uidOrNull) = 0;
  virtual void setOutputMode(HarborOutputMode mode) = 0;
  virtual void setDsdPcmLevel(int db) = 0;
  virtual bool load(const std::string& path) = 0;
  virtual void play() = 0;
  virtual void pause() = 0;
  virtual void stop() = 0;
  virtual void seek(double seconds) = 0;
  virtual void setVolume(float level) = 0;
  virtual HarborEngineState getState() = 0;
  virtual void setEventCallback(EventFn fn) = 0;
};

/** Shared / scaffold player — decodes via JUCE when available, else stub clock. */
IPlayer* createHarborPlayer();
