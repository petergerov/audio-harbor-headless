#include "LspPresets.h"

#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>

namespace fs = std::filesystem;

namespace {

/** The CLAP parameter id LSP's wrapper gives a port: its id hashed (clap_hash_string in lsp-plugin-fw). */
uint32_t portParamId(const std::string& port) {
  static const uint16_t primes[8] = {0x80ab, 0x815f, 0x8d41, 0x9161, 0x9463, 0x9b77, 0xabc1, 0xb567};
  size_t prime = 0;
  uint32_t h = uint32_t(port.size()) * primes[prime];
  for (char c : port) {
    prime = (prime + 1) % 8;
    h = uint32_t(h << 7) | ((h >> 25) & 0x7f);
    h += uint32_t(static_cast<unsigned char>(c)) * primes[prime];
  }
  return h;
}

std::string trim(const std::string& s) {
  const size_t a = s.find_first_not_of(" \t\r");
  if (a == std::string::npos) return {};
  const size_t b = s.find_last_not_of(" \t\r");
  return s.substr(a, b - a + 1);
}

/** "port = value" lines; '#' starts a comment, a value may be quoted. */
std::map<std::string, std::string> readPorts(const std::string& path) {
  std::map<std::string, std::string> ports;
  std::ifstream in(path);
  std::string line;
  while (std::getline(in, line)) {
    const std::string text = trim(line);
    if (text.empty() || text[0] == '#') continue;
    const size_t eq = text.find('=');
    if (eq == std::string::npos) continue;
    std::string value = trim(text.substr(eq + 1));
    if (value.size() >= 2 && value.front() == '"' && value.back() == '"') value = value.substr(1, value.size() - 2);
    ports[trim(text.substr(0, eq))] = value;
  }
  return ports;
}

} // namespace

std::vector<FxPreset> lspPresets(const std::string& clapPath, const std::string& pluginId) {
  if (pluginId.rfind("in.lsp-plug.", 0) != 0) return {};
  const fs::path folder = fs::path(clapPath).parent_path().parent_path() / "presets" / "lsp" / pluginId;
  auto presets = presetFiles({folder.string()}, ".preset", "Factory");
  // "Genre - Rock": the part before the dash is LSP's group.
  for (auto& p : presets) {
    const size_t dash = p.name.find(" - ");
    if (p.group == "Factory" && dash != std::string::npos) {
      p.group = p.name.substr(0, dash);
      p.name = p.name.substr(dash + 3);
    }
  }
  return presets;
}

bool lspLoadPreset(FxPlugin& plugin, const std::string& id, std::string& error) {
  const auto ports = readPorts(presetFilePath(id));
  if (ports.empty()) {
    error = "That preset file is empty or gone";
    return false;
  }
  const std::vector<FxParam> params = plugin.params();
  for (const auto& p : params) {
    if (!p.readOnly && !p.isBypass) plugin.setParam(p.id, p.def);
  }
  for (const auto& [port, value] : ports) {
    const std::string pid = std::to_string(portParamId(port));
    const FxParam* param = nullptr;
    for (const auto& p : params) {
      if (p.id == pid) param = &p;
    }
    if (!param || param->readOnly) continue;
    double v = 0;
    if (value == "true" || value == "false") {
      v = value == "true" ? 1 : 0;
    } else if (param->stepped) {
      // Switches and lists: the CLAP value is the port's own (an index).
      v = std::strtod(value.c_str(), nullptr);
    } else {
      // Gains ("2.63 db") and frequencies in the units the plugin reads; it maps them to its scale.
      std::string number = value;
      const size_t unit = number.find(" db");
      if (unit != std::string::npos) number = number.substr(0, unit);
      if (!plugin.parse(pid, number, v)) continue;
    }
    plugin.setParam(pid, v);
  }
  return true;
}
