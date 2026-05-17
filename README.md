# Four Winds

An Obsidian plugin for navigating the **relationships between notes** in a Zettelkasten — not as a flat web of backlinks, but as a four-way compass: *parent*, *child*, *supportive sibling*, *challenging sibling*.

Each note declares its compass relationships explicitly inside admonition blocks, so the connections you make are intentional rather than incidental. Four Winds renders those relationships in a sidebar view, walks you through unprocessed notes for triage, and back-fills missing reverse links across the vault on demand.

> Companion plugin to a Zettelkasten workflow — works alongside Dataview and the Admonition plugin (see [Dependencies](#dependencies)).

---

## Why a compass instead of backlinks?

Obsidian's native backlinks treat every `[[link]]` the same: a flat, undirected list of "this note mentions that note." That's powerful but it loses *meaning*. Was the link a parent / source idea? A peer that reinforces it? A counterpoint? You can't tell from a backlink panel.

Four Winds asks you to place each connection into one of four roles:

| Role | What it means |
|---|---|
| **Parent** | Notes this idea descends from — sources, foundations, broader concepts |
| **Child** | Notes that descend from this idea — refinements, applications, derivatives |
| **Supportive sibling** | Peers that reinforce or align with this idea |
| **Challenging sibling** | Peers that contrast with, complicate, or challenge this idea |

Parent ↔ child is **asymmetric** (if A is B's parent, B is A's child). Sibling relationships are **symmetric mirrors** (if A is B's supportive sibling, B is A's supportive sibling).

Crucially, links inside admonition blocks are **invisible to Obsidian's backlink index** — that's intentional. It separates the explicit, curated compass from the implicit, ambient mention graph.

---

## Install

Until Four Winds is in the official community plugin browser, install manually:

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [GitHub release](https://github.com/PoweredbyPugs/four-winds/releases).
2. Drop them into `<your vault>/.obsidian/plugins/four-winds/`.
3. Enable **Four Winds** in Settings → Community plugins.

Strongly recommended companion plugins:
- **Dataview** — required for the Compass View's incoming-reference panel.
- **Admonition** — gives the `ad-{name}` codeblocks a styled, collapsible appearance. Functionally optional; Four Winds parses the codeblocks regardless of how they render.

---

## Quick start

1. Open a note you want to map. Run **Four Winds: Open Compass View** from the command palette — a sidebar opens with four sections (Parent / Child / Supportive sibling / Challenging sibling), all empty.
2. Add a compass block to the note manually:

   ````markdown
   ```ad-north
   [[Some Foundational Note]]
   ```
   ````

   Now `Some Foundational Note` is declared as this note's parent. The Compass View updates automatically.
3. Add a few more across the four directions. Open **Four Winds: Open Navigation View** for a graph-style visualization.
4. Once you've connected several notes, run **Four Winds: Auto-link compass from references** — the plugin scans every note that lists you in *its* compass and back-fills the inverse role into yours. You go in once and your network of explicit relationships becomes self-consistent.

---

## The four blocks

By default, the four roles correspond to cardinal directions, with admonition tags `ad-north`, `ad-south`, `ad-east`, and `ad-west`:

| Role | Default tag |
|---|---|
| Parent | `ad-north` |
| Child | `ad-south` |
| Supportive sibling | `ad-east` |
| Challenging sibling | `ad-west` |

You can rename any of these in Settings → Compass — whatever you set there becomes both the on-disk tag (e.g. `ad-ancestor`) and the heading shown in the Compass View. See the [migration caveat](#renaming-roles) below.

**Inside a block**, list `[[Note Name]]` links one per line:

````markdown
```ad-north
[[Foundation A]]
[[Foundation B]]
```

```ad-south
[[Application X]]
[[Application Y]]
```
````

Aliased links (`[[Note|alias]]`), heading links (`[[Note#section]]`), and path-prefixed links (`[[folder/Note]]`) all work — Four Winds matches by basename.

---

## Commands

| Command | What it does |
|---|---|
| **Open Compass View** | Side panel with the active note's four compass sections. Each section combines two sources: literal links from the note's own admonition blocks, *and* dynamically-discovered incoming references (notes that list this one in their compass). |
| **Open Navigation View** | Full-tab cytoscape graph of compass connections branching from the active note. |
| **Process Seeds** | Swipe-card modal for triaging *fleeting notes* (raw, unprocessed entries). Each card represents one seed; swipe up/right/down/left to link it as parent / supportive sibling / child / challenging sibling of your active note, or skip / trash. Optionally runs a template to convert the seed into a structured note (see Processing settings). |
| **Discover** | Swipe-card modal that surfaces notes from your discovery folders so you can connect them into the active note's compass. Same swipe controls as Process Seeds, but no template processing — pure connection-making. See [Discover keyboard controls](#discover-keyboard-controls). |
| **Auto-link compass from references** | Scans every note in the vault for incoming compass references to the active note, then back-fills the inverse role into your compass. Pure additive: existing entries are never touched. Use it after a discovery session, or anytime you want to make sure your compass reflects what others have declared about it. |

### Discover keyboard controls

The Discover modal supports both swipe (touch / pointer drag) and keyboard input. The frame shows the four role names with their currently-bound keys; tap the **?** button in the top-right of the frame (or press `?`) to peek at the action-key legend.

| Key | Action |
|---|---|
| ↑ / ↓ / → / ← (rebindable) | Link the current card as parent / child / supportive sibling / challenging sibling of the active note. Defaults match the swipe directions; rebind any of them under Settings → Discovery direction keys. |
| `Space` | Skip the current card. |
| `O` | Open the current card's note in the workspace. |
| `D` | Mark the current card for deletion (batched; trashed on modal close, with a confirm prompt above 5). |
| `F` | Flip the card to show a mini-graph of its existing compass connections. |
| `Z` | Undo the last delete from this session. |
| `?` | Toggle the action-key legend popover. |

Only the four direction keys are rebindable. The action keys above are fixed.

---

## Settings

### Compass

Name each of the four roles. The name you set is used as the admonition tag suffix (`ad-{name}`) and as the heading in the Compass View. Defaults: `north`, `south`, `east`, `west`.

### Fleeting notes

Configures the Process Seeds flow:

- **Folder** — directories the modal scans for unprocessed notes.
- **Tag** — restrict to notes carrying a specific tag.
- **Sort mode** — shuffle / by creation date / by modification date / by tag.
- **Metadata field** — the inline field name (e.g. `seed::`) that holds the seed's capture text.

### Processing

Configure templates that Process Seeds applies when you decide a fleeting note is ready to become a structured note. Each template defines a path, a capture heading, a capture format string (with `{title}`, `{date}`, `{time}`, `{capture}` substitutions), and an optional destination folder.

### Discovery

Folders for the Discover modal to draw cards from, plus an **Auto-link** toggle. When auto-link is on, swipe-linking a card *also* writes the inverse-role link into the discovered note (parent ↔ child, sibling mirrors). When off, only your active note gets the link — the discovered note doesn't know it was connected.

### Stella integration

Optional. If the Stella plugin is installed and enabled, Four Winds can open Stella and load a freshly-processed note into its context automatically.

### Verify

Runs a configuration health check — folders exist, templates valid, capture format has substitution variables, optional integrations are reachable.

---

## Renaming roles

The setting that names a role drives the literal tag written to disk. If your notes have `ad-north` blocks and you rename `parent` to `ancestor`, the plugin starts writing `ad-ancestor` going forward — but the old `ad-north` blocks become invisible to the plugin until they're migrated.

**Until a migration command ships** (see [Roadmap](#roadmap)), you have two options:
- Leave defaults alone (`north` / `south` / `east` / `west`) so all your existing notes keep working.
- After renaming, do a vault-wide find/replace of the old tag for the new one.

---

## Dependencies

| Plugin | Required? | Why |
|---|---|---|
| [Dataview](https://github.com/blacksmithgu/obsidian-dataview) | Required for Compass View's incoming-reference panel | Four Winds uses Dataview to enumerate notes when scanning for who links to the current note. |
| [Admonition](https://github.com/javalent/admonitions) | Recommended | Renders `ad-{name}` codeblocks as styled callouts. Functionally optional — the plugin parses raw markdown regardless. |
| [Stella](https://github.com/PoweredbyPugs/stella) | Optional | Only needed if you want notes auto-loaded into Stella's context after processing. |

---

## Roadmap

- **Migrate compass tags across all notes** — a one-shot command to find `ad-{old-name}` blocks across the vault and rewrite them to `ad-{new-name}` after you rename a role. Will preview affected files before writing.
- **Compass-block-aware backlinks panel** — opt-in panel that *does* surface compass connections from incoming notes, for users who want a unified view.

---

## Contributing

Issues and PRs welcome at [github.com/PoweredbyPugs/four-winds](https://github.com/PoweredbyPugs/four-winds).

## License

MIT.
