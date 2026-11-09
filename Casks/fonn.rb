cask "fonn" do
  version "0.1.0"
  sha256 "226b69bc3449b3069bc1076b8a9a8e0fd9874b6f97c81144e721d12482fb4be5"

  url "https://github.com/nord-forge/fonn/releases/download/v#{version}/fonn-#{version}.tar.gz"
  name "Fonn"
  desc "Local coding agent harness for Claude and Codex"
  homepage "https://github.com/nord-forge/fonn"

  depends_on formula: "node"
  depends_on macos: ">= :sonoma"

  installer script: {
    executable: "#{Formula["node"].opt_bin}/node",
    args:       ["#{staged_path}/fonn/packaging/homebrew/runtime.mjs", "install",
                 "--npm", "#{Formula["node"].opt_bin}/npm"],
    sudo:       false,
  }

  command_wrapper "fonn",
                  executable: "#{Formula["node"].opt_bin}/node",
                  args:       ["#{staged_path}/fonn/packaging/homebrew/launcher.mjs", "fonn"]

  uninstall script: {
    executable: "#{Formula["node"].opt_bin}/node",
    args:       ["#{staged_path}/fonn/packaging/homebrew/runtime.mjs", "uninstall"],
    sudo:       false,
  }

  caveats <<~EOS
    Installation downloads pinned npm runtime dependencies on this machine.
    Install and authenticate Claude Code or Codex separately for native launches.
    fonn opens the native CLI selected by your profile. SDK runs require your own API key.
    Uninstall keeps your Fonn records and Claude settings.
  EOS
end
