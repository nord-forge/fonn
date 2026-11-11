# Fonn UI

`fonn ui` opens a local web interface for Fonn's hooks, settings, filter rules, profiles and history. Its first page, Agents, manages the hooks from [Use Fonn with the tools you already have](hooks.md). It runs inside the Fonn CLI, so there is nothing extra to install.

```sh
fonn ui              # starts the server and opens your browser
fonn ui --no-open    # prints the link instead
fonn ui --port 4400  # a fixed port instead of a random one
```

Press Ctrl+C in the terminal to stop it. Everything you change in the interface uses the same files and checks as `fonn config` and `fonn profiles`, so both stay in step.

## What you can do

| Page | What it does |
| --- | --- |
| Agents | The default page. One row for each of Claude Code, Codex, Crush and OpenCode, with its hook state: installed, needs update, or not installed. **Install**, **Update** and **Remove** each open a preview first: the config file, a diff of the change and any extra file Fonn writes or removes. Nothing is written until you confirm. If the file changed after the preview, Fonn asks you to review it again. A card only shows the actions that apply: Remove for a hook that is up to date, Update and Remove for one that needs updating, Install otherwise. Codex reminds you to review and trust the Fonn hook in Codex's `/hooks` once. Fonn never trusts it for you |
| Rules | Your global filter rules: add, edit, delete and save them |
| Test bench | Paste a command and its output and see exactly what the model would receive with a project's settings and rules, or with a rule you are still editing. Nothing is saved or archived |
| Activity | Recent native launches, titled by project, agent and profile, and SDK runs, each with filter totals. Sessions from a global hook are marked "via hook". **Clean up old records** deletes records, with their archived originals, that were not used for more than 7, 30, 90 or 180 days. It shows how many and how much space first, and asks before deleting |
| Launch detail | Each filter decision. Hook sessions carry the same "via hook" mark. "View original" loads the archived original in bounded slices and shows it as command output, with "Show raw JSON" for the exact stored response. You can delete the launch's records and archived originals to free space |
| Overview | Hooks installed, global filter rules, sessions and projects at the top. The filter settings (filter mode and filter level) come first, because the hook uses them. Profile and subagents sit under **Launch settings**, because they only apply when Fonn starts the agent with `fonn claude` or `fonn codex`. Each can be reset to the built-in default. Launch settings also show the exact startup guidance Fonn adds when subagents are on. Version, Node and the config and state folders are at the bottom |
| Profiles | The default profile at the top, then your own profiles and the built-in ones by agent. Create a profile, or copy a built-in one to change its model or effort. A Codex profile can run on OpenAI, a local model through Ollama or LM Studio, or another provider from your Codex config. Edit or delete your own, and use any profile as the default |
| Open a project | Open any Git repository or Fonn project by its path, pick the folder in your system's folder dialog, or choose one of the projects Fonn already knows |
| Projects | Tabs. **Overview** shows what a new launch uses and where each value comes from, how many rules apply, and three key numbers. **Settings** and **Rules** each have one editor with a Personal or Shared switch for which file to save. **Rules** also lists the rules that apply and the approval for project rules. **Instructions** opens files such as `CLAUDE.md` and `AGENTS.md`, and **Activity** has the project's totals, launches and runs. Rules waiting for approval show a notice above the tabs |

Character counts are characters in observations. They are not tokens or costs.

## Filter rules

A rule removes lines that contain some text, for commands that start with a given command. Write one text per line under "Remove lines containing". Lines about errors, failures, warnings or security are always kept, and originals stay recoverable. "Try this rule" opens the test bench with only that rule, so you can see its effect before saving. See [your own rules](filtering.md#your-own-rules) for the details.

Rules from project files only apply after you approve them, because anyone who can commit to the repository can write them. The project page lists rules waiting for approval with an "Approve these rules" button. If the rules change after you approve them, new launches skip them until you approve again. Running and resumed launches keep the rules they started with. Saving your own changes on the project page keeps an approval you already gave, but never approves rules someone else committed.

A project file that changed on disk after the page loaded, for example after a `git pull`, is never overwritten. Saving says so instead, and reloading the page shows the new contents.

Deleting something always asks first, in a dialog. Deleting a launch that has no recorded finish asks a second time, because it may still be running.

## Privacy and security

The interface reads and changes your Fonn settings and records, and shows archived originals, which can contain private code and output. It is built so that only you can use it:

- It listens on `127.0.0.1` only, so other machines on your network cannot reach it.
- Each start creates a new random link. Opening it once sets a private cookie for this server, and the link stops being needed. Do not share the link while the server runs.
- Other websites cannot read from it or change anything. The server checks the Host and Origin of every request, changes also need JSON and a header only the interface sends, and other pages cannot embed it.
- Request bodies are limited to 64 KB, or 512 KB for the test bench.
- Credentials and environment variables are never sent to the browser. Archived originals are only sent in slices of at most 20,000 characters.
- Paths in your home folder show as `~`, such as `~/.codex/hooks.json`, so screenshots do not carry your user name. This only changes what is shown.
- Projects are limited to those in your launch or run records, Git repository roots, and folders with a Fonn settings file. Only a fixed list of instruction files can be read from them, and symlinks are refused.

Browsers never tell a web page the full path of a folder you choose, so "Choose folder" asks the local server to show the system dialog: macOS's own folder chooser, or zenity or kdialog on Linux when one is installed. Fonn only receives the path you choose and reads nothing else from that folder until you open it. Without a dialog, the button is hidden and you type the path.

After a restart, an old browser tab shows "This session has ended". Run `fonn ui` again and open the new link.
