#include "ClapPresets.h"

#include <json.hpp>

#include <algorithm>
#include <cstring>
#include <filesystem>
#include <system_error>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace {

constexpr const char* kIdPrefix = "clap:";

struct Location {
  uint32_t flags = 0;
  std::string name;
  uint32_t kind = CLAP_PRESET_DISCOVERY_LOCATION_FILE;
  std::optional<std::string> path;
};

/** What a provider declares in init(): where its presets are and which files they are. */
struct Declarations {
  std::vector<std::string> extensions;
  std::vector<Location> locations;
};

/** One get_metadata() call: the presets in one file (or the plugin), kept if they are for us. */
struct Collector {
  const std::string* pluginId = nullptr;
  const Location* location = nullptr;
  std::optional<std::string> file;
  std::string group;
  std::vector<FxPreset>* out = nullptr;
  std::vector<bool>* factory = nullptr;

  // The preset begun last, until the next begin_preset or the end of the call.
  bool open = false;
  bool ours = false;
  bool isFactory = false;
  FxPreset current;

  void finish() {
    if (open && ours) {
      out->push_back(current);
      factory->push_back(isFactory);
    }
    open = false;
  }
};

Collector* collector(const clap_preset_discovery_metadata_receiver* r) {
  return static_cast<Collector*>(r->receiver_data);
}

std::string presetId(uint32_t kind, const std::optional<std::string>& location, const char* loadKey) {
  json j = json::array({kind, location ? json(*location) : json(nullptr), loadKey ? json(loadKey) : json(nullptr)});
  return kIdPrefix + j.dump();
}

clap_preset_discovery_metadata_receiver receiverFor(Collector& c) {
  clap_preset_discovery_metadata_receiver r {};
  r.receiver_data = &c;
  r.on_error = [](const clap_preset_discovery_metadata_receiver*, int32_t, const char*) {};
  r.begin_preset = [](const clap_preset_discovery_metadata_receiver* self, const char* name, const char* loadKey) {
    Collector* c = collector(self);
    c->finish();
    c->open = true;
    c->ours = false;
    c->isFactory = (c->location->flags & CLAP_PRESET_DISCOVERY_IS_FACTORY_CONTENT) != 0;
    std::string label = name && *name ? name : (c->file ? fs::path(*c->file).stem().string() : "Preset");
    c->current = {presetId(c->location->kind, c->file, loadKey), label, c->group};
    return true;
  };
  r.add_plugin_id = [](const clap_preset_discovery_metadata_receiver* self, const clap_universal_plugin_id_t* id) {
    Collector* c = collector(self);
    if (id && id->abi && id->id && !std::strcmp(id->abi, "clap") && *c->pluginId == id->id) c->ours = true;
  };
  r.set_soundpack_id = [](const clap_preset_discovery_metadata_receiver*, const char*) {};
  r.set_flags = [](const clap_preset_discovery_metadata_receiver* self, uint32_t flags) {
    Collector* c = collector(self);
    if (flags & CLAP_PRESET_DISCOVERY_IS_FACTORY_CONTENT) c->isFactory = true;
    if (flags & CLAP_PRESET_DISCOVERY_IS_USER_CONTENT) c->isFactory = false;
  };
  r.add_creator = [](const clap_preset_discovery_metadata_receiver*, const char*) {};
  r.set_description = [](const clap_preset_discovery_metadata_receiver*, const char*) {};
  r.set_timestamps = [](const clap_preset_discovery_metadata_receiver*, clap_timestamp, clap_timestamp) {};
  r.add_feature = [](const clap_preset_discovery_metadata_receiver*, const char*) {};
  r.add_extra_info = [](const clap_preset_discovery_metadata_receiver*, const char*, const char*) {};
  return r;
}

clap_preset_discovery_indexer indexerFor(Declarations& d) {
  clap_preset_discovery_indexer ix {};
  ix.clap_version = CLAP_VERSION;
  ix.name = "Audio Harbor Headless";
  ix.vendor = "Audio Harbor";
  ix.url = "https://github.com/petergerov/audio-harbor-headless";
  ix.version = "1";
  ix.indexer_data = &d;
  ix.declare_filetype = [](const clap_preset_discovery_indexer* self, const clap_preset_discovery_filetype* t) {
    auto* d = static_cast<Declarations*>(self->indexer_data);
    if (t && t->file_extension) d->extensions.push_back(t->file_extension);
    return true;
  };
  ix.declare_location = [](const clap_preset_discovery_indexer* self, const clap_preset_discovery_location* l) {
    auto* d = static_cast<Declarations*>(self->indexer_data);
    if (!l) return false;
    Location loc;
    loc.flags = l->flags;
    loc.name = l->name ? l->name : "";
    loc.kind = l->kind;
    if (l->location) loc.path = l->location;
    d->locations.push_back(std::move(loc));
    return true;
  };
  ix.declare_soundpack = [](const clap_preset_discovery_indexer*, const clap_preset_discovery_soundpack*) {
    return true;
  };
  ix.get_extension = [](const clap_preset_discovery_indexer*, const char*) -> const void* { return nullptr; };
  return ix;
}

bool wanted(const fs::path& file, const std::vector<std::string>& extensions) {
  if (extensions.empty()) return true;
  std::string ext = file.extension().string();
  if (!ext.empty() && ext[0] == '.') ext.erase(0, 1);
  return std::find(extensions.begin(), extensions.end(), ext) != extensions.end();
}

/** Every preset file of a FILE location: the file itself, or those below the folder. */
std::vector<fs::path> filesOf(const Location& loc, const std::vector<std::string>& extensions) {
  std::vector<fs::path> files;
  std::error_code ec;
  if (!loc.path) return files;
  const fs::path root(*loc.path);
  if (fs::is_regular_file(root, ec)) return {root};
  if (!fs::is_directory(root, ec)) return files;
  for (auto it = fs::recursive_directory_iterator(root, fs::directory_options::skip_permission_denied, ec);
       !ec && it != fs::recursive_directory_iterator(); it.increment(ec)) {
    if (it->is_regular_file(ec) && wanted(it->path(), extensions)) files.push_back(it->path());
  }
  std::sort(files.begin(), files.end());
  return files;
}

/** The folder a file is in below its location ("Mastering"); the location's name for its own files. */
std::string groupOf(const Location& loc, const fs::path& file) {
  if (!loc.path) return loc.name;
  const fs::path folder = file.parent_path().lexically_relative(*loc.path);
  return folder.empty() || folder == "." ? loc.name : folder.generic_string();
}

void index(const clap_preset_discovery_provider* provider, const Declarations& d, const std::string& pluginId,
           std::vector<FxPreset>& out, std::vector<bool>& factory) {
  for (const auto& loc : d.locations) {
    Collector c;
    c.pluginId = &pluginId;
    c.location = &loc;
    c.out = &out;
    c.factory = &factory;
    const clap_preset_discovery_metadata_receiver receiver = receiverFor(c);
    if (loc.kind == CLAP_PRESET_DISCOVERY_LOCATION_PLUGIN) {
      c.group = loc.name;
      provider->get_metadata(provider, loc.kind, nullptr, &receiver);
      c.finish();
      continue;
    }
    for (const auto& file : filesOf(loc, d.extensions)) {
      c.file = file.string();
      c.group = groupOf(loc, file);
      provider->get_metadata(provider, loc.kind, c.file->c_str(), &receiver);
      c.finish();
    }
  }
}

} // namespace

std::vector<FxPreset> clapDiscoveredPresets(const clap_plugin_entry* entry, const std::string& pluginId) {
  std::vector<FxPreset> found;
  std::vector<bool> factory;
  const void* raw = entry->get_factory(CLAP_PRESET_DISCOVERY_FACTORY_ID);
  if (!raw) raw = entry->get_factory(CLAP_PRESET_DISCOVERY_FACTORY_ID_COMPAT);
  const auto* discovery = static_cast<const clap_preset_discovery_factory*>(raw);
  if (!discovery) return found;
  for (uint32_t i = 0, n = discovery->count(discovery); i < n; ++i) {
    const clap_preset_discovery_provider_descriptor* desc = discovery->get_descriptor(discovery, i);
    if (!desc || !desc->id) continue;
    Declarations d;
    const clap_preset_discovery_indexer ix = indexerFor(d);
    const clap_preset_discovery_provider* provider = discovery->create(discovery, &ix, desc->id);
    if (!provider) continue;
    if (provider->init(provider)) index(provider, d, pluginId, found, factory);
    provider->destroy(provider);
  }
  // Factory content first, each part in the order the providers gave it.
  std::vector<FxPreset> out;
  for (int pass = 0; pass < 2; ++pass) {
    for (size_t i = 0; i < found.size(); ++i) {
      if (factory[i] == (pass == 0)) out.push_back(found[i]);
    }
  }
  return out;
}

std::optional<ClapPresetLocation> clapPresetLocation(const std::string& id) {
  if (id.rfind(kIdPrefix, 0) != 0) return std::nullopt;
  const json j = json::parse(id.substr(std::strlen(kIdPrefix)), nullptr, false);
  if (!j.is_array() || j.size() != 3 || !j[0].is_number_unsigned()) return std::nullopt;
  ClapPresetLocation loc;
  loc.kind = j[0].get<uint32_t>();
  if (j[1].is_string()) loc.location = j[1].get<std::string>();
  if (j[2].is_string()) loc.loadKey = j[2].get<std::string>();
  return loc;
}
