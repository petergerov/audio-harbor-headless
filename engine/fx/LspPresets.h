#pragma once

#include "FxPlugin.h"

#include <string>
#include <vector>

/**
 * LSP Plugins' own presets. LSP ships them for its UI, which the rack's build leaves out, so the
 * package puts them next to the CLAP file: <dir of lsp-plugins.clap>/../presets/lsp/<plugin id>/,
 * text files of "port = value".
 */
std::vector<FxPreset> lspPresets(const std::string& clapPath, const std::string& pluginId);

/** Defaults first, then each port of the file through the parameter it is (LSP's CLAP ids). */
bool lspLoadPreset(FxPlugin& plugin, const std::string& id, std::string& error);
