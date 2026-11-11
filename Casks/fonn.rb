cask "fonn" do
  version "0.2.3"
  sha256 "f7f1b35cfecb5d8c0ed7049c2e8c3ce12221c71003715ca9598d3a6a746e68d4"

  url "https://github.com/nord-forge/fonn/releases/download/v#{version}/fonn-#{version}.tar.gz"
  name "Fonn"
  desc "Shortens noisy command output for coding agents"
  homepage "https://github.com/nord-forge/fonn"

  depends_on formula: "node"
  depends_on macos: :sonoma

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
