# Fonn UI

`fonn ui` opens a local web interface for Fonn's settings, filter rules, profiles and history. It runs inside the Fonn CLI, so there is nothing extra to install: the Homebrew cask and a source checkout both include it.

```sh
fonn ui              # starts the server and opens your browser
fonn ui --no-open    # prints the link instead
fonn ui --port 4400  # a fixed port instead of a random one
```

Press Ctrl+C in the terminal to stop it. Everything you change in the interface uses the same files and checks as `fonn config` and `fonn profiles`, so both stay in step.

## What you can do

| Page | What it does |
| --- | --- |
| Overview | Version, Node and the config and state folders. Change each global setting (profile, filter level, filter mode, subagents) or reset it to the built-in default. Also shows the exact startup guidance Fonn adds when subagents are on |
| Profiles | Built-in and custom profiles. Create a profile, edit or delete a custom one, and make any profile the default |
| Rules | Your global filter rules: add, edit, delete and save them |
| Test bench | Paste a command and its output and see exactly what the model would receive with a project's settings and rules, or with a rule you are still editing. Nothing is saved or archived |
| Projects | Effective settings with their sources, editors for the shared `.fonn.json` and the personal `.fonn/settings.local.json` (settings and rules), project rule approval, instruction files such as `CLAUDE.md` and `AGENTS.md`, and that project's activity. "Open by path" in the sidebar opens any Git repository or Fonn project |
| Activity | Recent native launches, titled by project, agent and profile, and SDK runs, each with filter totals |
| Launch detail | Each filter decision. "View original" loads the archived original in bounded slices and shows it as command output, with "Show raw JSON" for the exact stored response. You can delete the launch's records and archived originals to free space |

Character counts are characters in observations. They are not tokens or costs.

## Filter rules

A rule removes lines that contain some text, for commands that start with a given command. Write one text per line under "Remove lines containing". Lines about errors, failures, warnings or security are always kept, and originals stay recoverable. "Try this rule" opens the test bench with only that rule, so you can see its effect before saving. See [your own rules](filtering.md#your-own-rules) for the details.

Rules from project files only apply after you approve them, because anyone who can commit to the repository can write them. The project page lists rules waiting for approval with an "Approve these rules" button. If the rules change after you approve them, new launches skip them until you approve again. Running and resumed launches keep the rules they started with. Saving your own changes on the project page keeps an approval you already gave, but never approves rules someone else committed.

A project file that changed on disk after the page loaded, for example after a `git pull`, is never overwritten. Saving says so instead, and reloading the page shows the new contents.

Deleting a launch that has no recorded finish asks you to confirm, because it may still be running.

## Privacy and security

The interface reads and changes your Fonn settings and records, and shows archived originals, which can contain private code and output. It is built so that only you can use it:

- It listens on `127.0.0.1` only, so other machines on your network cannot reach it.
- Each start creates a new random link. Opening it once sets a private cookie for this server, and the link stops being needed. Do not share the link while the server runs.
- Other websites cannot read from it or change anything. The server checks the Host and Origin of every request, changes also need JSON and a header only the interface sends, and other pages cannot embed it.
- Request bodies are limited to 64 KB, or 512 KB for the test bench.
- Credentials and environment variables are never sent to the browser. Archived originals are only sent in slices of at most 20,000 characters.
- Projects are limited to those in your launch or run records, Git repository roots, and folders with a Fonn settings file. Only a fixed list of instruction files can be read from them, and symlinks are refused.

After a restart, an old browser tab shows "This session has ended". Run `fonn ui` again and open the new link.
