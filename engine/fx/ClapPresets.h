#pragma once

#include "FxPlugin.h"

#include <clap/clap.h>

#include <optional>
#include <string>
#include <vector>

/** Where clap_plugin_preset_load.from_location finds a preset. */
struct ClapPresetLocation {
  uint32_t kind = CLAP_PRESET_DISCOVERY_LOCATION_FILE;
  std::optional<std::string> location;
  std::optional<std::string> loadKey;
};

/**
 * The presets a CLAP file's preset providers index for one of its plugins (CLAP preset
 * discovery): factory content first, then the rest, each group a declared location.
 */
std::vector<FxPreset> clapDiscoveredPresets(const clap_plugin_entry* entry, const std::string& pluginId);

/** A discovered preset's id back to its location; nullopt for any other id. */
std::optional<ClapPresetLocation> clapPresetLocation(const std::string& id);
