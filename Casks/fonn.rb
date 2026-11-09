cask "fonn" do
  version "0.1.0"
  sha256 "9143b6ca1cc88ab3dc8f00cb40048c9b99e26f07ccc8038eacff24ade3005ffa"

  url "https://github.com/nord-forge/fonn/releases/download/v#{version}/fonn-#{version}.tar.gz"
  name "Fonn"
  desc "Local Claude agent harness and interactive launcher"
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
    For interactive Claude, install and authenticate Claude Code separately.
    fonn opens the interactive Claude launcher. SDK runs require your own API key.
    Uninstall keeps your Fonn records and Claude settings.
  EOS
end
