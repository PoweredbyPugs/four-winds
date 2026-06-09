/* main.ts — Four Winds Plugin */

import {
	Plugin,
	ItemView,
	WorkspaceLeaf,
	TFile,
	TFolder,
	Modal,
	Setting,
	PluginSettingTab,
	MarkdownRenderer,
	Menu,
	Notice,
	FuzzySuggestModal,
	TextAreaComponent,
} from "obsidian";
import type cytoscape from "cytoscape";
import * as cytoscapeImport from "cytoscape";
const cytoscapeFn = (cytoscapeImport as any).default
	? (cytoscapeImport as any).default
	: cytoscapeImport;

// Extend the App type to include plugins
declare module "obsidian" {
	interface App {
		plugins: {
			getPlugin: (id: string) => any;
		};
	}
}

/*──────────────────────────────────────────────
   Settings
──────────────────────────────────────────────*/
type SeedSortMode = "shuffle" | "cday" | "mday" | "tag";

// Internal role ids. Stable identifiers used throughout the code; never
// shown to the user. The user-facing name for each role lives in
// settings.directionNames and acts as BOTH the admonition tag suffix on
// disk (ad-{name}) and the heading shown in the UI — one source of truth.
type Role = "parent" | "child" | "supportive_sibling" | "challenging_sibling";
const ROLES: Role[] = ["parent", "child", "supportive_sibling", "challenging_sibling"];

// Inversion semantics for auto-link + swipe-time reverse-write.
// parent/child are asymmetric (if Other has me as parent, Other goes in my
// child); siblings are symmetric (mutual mirror).
const INVERSE_ROLE: Record<Role, Role> = {
	parent: "child",
	child: "parent",
	supportive_sibling: "supportive_sibling",
	challenging_sibling: "challenging_sibling",
};

// Defaults match the cardinal-direction tags users already have in their
// vaults (`ad-north` etc.) so nothing breaks until they explicitly rename.
const DEFAULT_DIRECTION_NAMES: Record<Role, string> = {
	parent: "north",
	child: "south",
	supportive_sibling: "east",
	challenging_sibling: "west",
};

// Stable, user-facing role labels. Used wherever the settings UI talks
// about the role itself (not the user-renamed compass direction). The
// modal's edge labels still use settings.directionNames so they reflect
// the user's compass-direction rename.
const ROLE_LABELS: Record<Role, string> = {
	parent: "Parent",
	child: "Child",
	supportive_sibling: "Supportive sibling",
	challenging_sibling: "Challenging sibling",
};

// Default keyboard bindings for Discovery. Arrows mirror the existing
// ▲▶▼◀ swipe semantics. User-rebindable per role in settings; stored as
// lowercase so case-insensitive comparison works for letter keys.
const DEFAULT_DISCOVERY_KEYS: Record<Role, string> = {
	parent: "arrowup",
	supportive_sibling: "arrowright",
	child: "arrowdown",
	challenging_sibling: "arrowleft",
};

interface FourWindsSettings {
	seedDirectories: string[];
	discoveryDirectories: string[];
	autoLink: boolean;
	// Per-role admonition name. Used as the tag suffix on disk (ad-{name})
	// AND as the heading shown in the UI.
	directionNames: Record<Role, string>;
	// Per-role keyboard binding for the Discovery modal. Stored as the
	// lowercase form of e.key (e.g. "arrowup", "w", "j"). Compared
	// case-insensitively at handler time.
	discoveryKeys: Record<Role, string>;
	// Seeds
	seedTags: string[];
	seedSortMode: SeedSortMode;
	seedField: string;
	// Processing
	templates: Array<{
		path: string;
		captureHeading: string;
		captureFormat: string;
		destinationFolder: string;
	}>;
	// Stella
	stellaOnProcess: boolean;
}

const DEFAULT_SETTINGS: FourWindsSettings = {
	seedDirectories: ["Forest"],
	discoveryDirectories: ["Forest", "Garden"],
	autoLink: false,
	directionNames: { ...DEFAULT_DIRECTION_NAMES },
	discoveryKeys: { ...DEFAULT_DISCOVERY_KEYS },
	seedTags: [],
	seedSortMode: "shuffle",
	seedField: "seed",
	templates: [],
	stellaOnProcess: false,
};

// Resolve the full admonition block tag (e.g. "ad-north") for a role.
// Falls back to the default if the setting is missing/empty so the plugin
// never tries to read/write an empty block id.
function tagFor(settings: FourWindsSettings, role: Role): string {
	const name = (settings.directionNames && settings.directionNames[role]) || DEFAULT_DIRECTION_NAMES[role];
	return "ad-" + name;
}

/*──────────────────────────────────────────────
   SwipeHandler — reusable pointer-event handler
──────────────────────────────────────────────*/
type SwipeDirection = "left" | "right" | "up" | "down";

interface SwipeHandlerOptions {
	el: HTMLElement;
	threshold?: number;
	horizontalOnly?: boolean;
	onSwipe: (dir: SwipeDirection) => void;
	onTap?: () => void;
	onMove?: (dx: number, dy: number) => void;
}

class SwipeHandler {
	private el: HTMLElement;
	private threshold: number;
	private horizontalOnly: boolean;
	private onSwipe: (dir: SwipeDirection) => void;
	private onTap?: () => void;
	private onMove?: (dx: number, dy: number) => void;

	private startX = 0;
	private startY = 0;
	private tracking = false;

	private boundDown: (e: PointerEvent) => void;
	private boundMove: (e: PointerEvent) => void;
	private boundUp: (e: PointerEvent) => void;

	constructor(opts: SwipeHandlerOptions) {
		this.el = opts.el;
		this.threshold = opts.threshold ?? 50;
		this.horizontalOnly = opts.horizontalOnly ?? false;
		this.onSwipe = opts.onSwipe;
		this.onTap = opts.onTap;
		this.onMove = opts.onMove;

		this.boundDown = this.handleDown.bind(this);
		this.boundMove = this.handleMove.bind(this);
		this.boundUp = this.handleUp.bind(this);

		this.el.addEventListener("pointerdown", this.boundDown);
		this.el.addEventListener("pointermove", this.boundMove);
		this.el.addEventListener("pointerup", this.boundUp);
		this.el.style.touchAction = "none";
	}

	private handleDown(e: PointerEvent) {
		// Only the primary button (or touch/pen contact) starts a swipe/tap.
		// Right-click must pass through untouched: tracking it would (a) read
		// the release as a tap and flip the card, and (b) setPointerCapture
		// would steal the pointer sequence from cytoscape, so the card-back
		// graph's context menu (cxttap) never fires.
		if (e.button !== 0) return;
		// Don't capture on interactive elements
		const target = e.target as HTMLElement;
		if (target.closest("select, input, textarea, button, .four-winds-tag, .four-winds-tag-add, .four-winds-tag-add-wrapper")) {
			return;
		}
		this.startX = e.clientX;
		this.startY = e.clientY;
		this.tracking = true;
		this.el.setPointerCapture(e.pointerId);
	}

	private handleMove(e: PointerEvent) {
		if (!this.tracking) return;
		const dx = e.clientX - this.startX;
		const dy = e.clientY - this.startY;
		this.onMove?.(dx, dy);
	}

	private handleUp(e: PointerEvent) {
		if (!this.tracking) return;
		this.tracking = false;

		const dx = e.clientX - this.startX;
		const dy = e.clientY - this.startY;
		const absDx = Math.abs(dx);
		const absDy = Math.abs(dy);

		if (this.horizontalOnly) {
			if (absDx > this.threshold) {
				this.onSwipe(dx < 0 ? "left" : "right");
				return;
			}
		} else {
			if (absDx > this.threshold || absDy > this.threshold) {
				if (absDx > absDy) {
					this.onSwipe(dx < 0 ? "left" : "right");
				} else {
					this.onSwipe(dy < 0 ? "up" : "down");
				}
				return;
			}
		}

		// Below threshold — tap
		this.onTap?.();
	}

	destroy() {
		this.el.removeEventListener("pointerdown", this.boundDown);
		this.el.removeEventListener("pointermove", this.boundMove);
		this.el.removeEventListener("pointerup", this.boundUp);
	}
}

/*──────────────────────────────────────────────
   Helper: Fisher-Yates shuffle
──────────────────────────────────────────────*/
function shuffle<T>(arr: T[]): T[] {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

/*──────────────────────────────────────────────
   Helper: Gather .md files from directories
──────────────────────────────────────────────*/
function gatherFiles(app: any, directories: string[]): TFile[] {
	const files: TFile[] = [];
	const seen = new Set<string>();
	for (const dirPath of directories) {
		const folder = app.vault.getAbstractFileByPath(dirPath);
		if (!(folder instanceof TFolder)) continue;
		collectMarkdownFiles(folder, files, seen);
	}
	return files;
}

function collectMarkdownFiles(folder: TFolder, out: TFile[], seen: Set<string>) {
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === "md" && !seen.has(child.path)) {
			seen.add(child.path);
			out.push(child);
		} else if (child instanceof TFolder) {
			collectMarkdownFiles(child, out, seen);
		}
	}
}

/*──────────────────────────────────────────────
   Helper: addLinkToBlock
──────────────────────────────────────────────*/
let linkMutex = false;

// Insert [[targetName]] into the given admonition block in filePath. If the
// block doesn't exist it's created at the end of the file. Already-present
// links are detected and skipped. blockTag is the full admonition id
// (e.g. "ad-north"); resolve it via tagFor(settings, role) at the call
// site so the role→name mapping stays in one place.
async function addLinkToBlock(
	app: any,
	filePath: string,
	targetName: string,
	blockTag: string
): Promise<void> {
	// Simple mutex to prevent race conditions on rapid swipes
	while (linkMutex) {
		await new Promise((r) => setTimeout(r, 50));
	}
	linkMutex = true;
	try {
		const file = app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		let content = await app.vault.read(file);
		const link = `[[${targetName}]]`;
		const blockRegex = new RegExp("```" + escapeRegExpStr(blockTag) + "\\n([\\s\\S]*?)```", "m");
		const match = blockRegex.exec(content);

		if (match) {
			// Block exists — check if link already present
			if (match[1].contains(link)) return;
			const insertPos = match.index + match[0].length - 3; // before closing ```
			content = content.slice(0, insertPos) + link + "\n" + content.slice(insertPos);
		} else {
			// Create new block at end of file
			content = content.trimEnd() + "\n\n```" + blockTag + "\n" + link + "\n```\n";
		}

		await app.vault.modify(file, content);
	} finally {
		linkMutex = false;
	}
}

/*──────────────────────────────────────────────
   Helper: extractCompassByRole
──────────────────────────────────────────────*/
// Parse a note's content and return, for each role, the set of basenames
// currently listed in that role's compass block. Tag lookup honors the
// user's directionNames setting. Aliased / heading / path-prefixed link
// forms are normalized to bare basenames.
function extractCompassByRole(
	content: string,
	settings: FourWindsSettings
): Record<Role, Set<string>> {
	const out: Record<Role, Set<string>> = {
		parent: new Set(),
		child: new Set(),
		supportive_sibling: new Set(),
		challenging_sibling: new Set(),
	};
	for (const role of ROLES) {
		const tag = tagFor(settings, role);
		const blockRe = new RegExp("```" + escapeRegExpStr(tag) + "\\n([\\s\\S]*?)```", "gm");
		let m: RegExpExecArray | null;
		while ((m = blockRe.exec(content)) !== null) {
			const linkRe = /\[\[([^\]\n|#]+)(?:[#|][^\]\n]*)?\]\]/g;
			let lm: RegExpExecArray | null;
			while ((lm = linkRe.exec(m[1])) !== null) {
				const name = lm[1].trim();
				const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
				const trimmed = base.replace(/\.md$/i, "").trim();
				if (trimmed) out[role].add(trimmed);
			}
		}
	}
	return out;
}

/*──────────────────────────────────────────────
   Helper: findIncomingCompassReferences
──────────────────────────────────────────────*/
// Scan every markdown file in the vault for any of the four configured
// compass admonition blocks containing [[targetBasename]] (with or without
// a path prefix, alias, or heading). Returns one (file, role) pair per
// (file × role) that references the target. Used by Auto-link to discover
// incoming compass references — Obsidian's metadataCache and backlink
// index intentionally ignore links inside code blocks, so a vault scan is
// required. Tags come from the live settings, so renaming a role's name
// is picked up immediately on the next scan.
async function findIncomingCompassReferences(
	app: any,
	settings: FourWindsSettings,
	targetBasename: string,
	excludePath: string
): Promise<Array<{ file: TFile; role: Role }>> {
	const out: Array<{ file: TFile; role: Role }> = [];
	const linkPattern = new RegExp(
		"\\[\\[(?:[^\\]\\n#|]*\\/)?" + escapeRegExpStr(targetBasename) + "(?:[#|][^\\]\\n]*)?\\]\\]"
	);
	const roleTagPairs: Array<{ role: Role; tag: string }> = ROLES.map((role) => ({
		role,
		tag: tagFor(settings, role),
	}));

	for (const file of app.vault.getMarkdownFiles() as TFile[]) {
		if (file.path === excludePath) continue;
		const content: string = await app.vault.cachedRead(file);
		// Cheap early-out — most files won't mention the basename at all.
		if (!content.includes(targetBasename)) continue;
		for (const { role, tag } of roleTagPairs) {
			const blockRegex = new RegExp("```" + escapeRegExpStr(tag) + "\\n([\\s\\S]*?)```", "gm");
			let m: RegExpExecArray | null;
			let foundInRole = false;
			while ((m = blockRegex.exec(content)) !== null) {
				if (linkPattern.test(m[1])) {
					foundInRole = true;
					break;
				}
			}
			if (foundInRole) out.push({ file, role });
		}
	}
	return out;
}

/*──────────────────────────────────────────────
   Helper: get tags from a file
──────────────────────────────────────────────*/
function getFileTags(app: any, file: TFile): string[] {
	const cache = app.metadataCache.getFileCache(file);
	const tags: string[] = [];
	if (cache?.frontmatter?.tags) {
		const t = cache.frontmatter.tags;
		if (Array.isArray(t)) tags.push(...t);
		else if (typeof t === "string") tags.push(t);
	}
	return tags;
}

/*──────────────────────────────────────────────
   Helper: extract seed capture from content
──────────────────────────────────────────────*/
function extractSeedCapture(content: string, fieldName: string): string {
	// Match inline dataview field: `fieldName:: value`
	const regex = new RegExp(`^${escapeRegExpStr(fieldName)}::(.+)$`, "m");
	const match = regex.exec(content);
	return match ? match[1].trim() : "";
}

function escapeRegExpStr(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/*──────────────────────────────────────────────
   Helper: sort files by mode
──────────────────────────────────────────────*/
function sortFiles(files: TFile[], mode: SeedSortMode, app: any, filterTag?: string): TFile[] {
	let filtered = files;

	// Filter by tag if set
	if (filterTag) {
		filtered = filtered.filter((f) => getFileTags(app, f).includes(filterTag));
	}

	switch (mode) {
		case "cday":
			return [...filtered].sort((a, b) => a.stat.ctime - b.stat.ctime);
		case "mday":
			return [...filtered].sort((a, b) => b.stat.mtime - a.stat.mtime);
		case "tag":
			return [...filtered].sort((a, b) => {
				const ta = getFileTags(app, a).join(",");
				const tb = getFileTags(app, b).join(",");
				return ta.localeCompare(tb);
			});
		case "shuffle":
		default:
			return shuffle(filtered);
	}
}

/*──────────────────────────────────────────────
   Helper: get all tags from vault
──────────────────────────────────────────────*/
function getAllVaultTags(app: any): string[] {
	const tags = new Set<string>();
	for (const file of app.vault.getMarkdownFiles()) {
		for (const t of getFileTags(app, file)) {
			tags.add(t);
		}
	}
	return [...tags].sort();
}

/*──────────────────────────────────────────────
   Fuzzy File Picker Modal
──────────────────────────────────────────────*/
class FileSuggestModal extends FuzzySuggestModal<TFile> {
	private files: TFile[];
	private onChoose: (file: TFile) => void;

	constructor(app: any, files: TFile[], onChoose: (file: TFile) => void) {
		super(app);
		this.files = files;
		this.onChoose = onChoose;
		this.setPlaceholder("Search for a note...");
		this.modalEl.addClass("four-winds-modal");
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		this.onChoose(item);
	}
}

/*──────────────────────────────────────────────
   Template Chooser Modal (for process)
──────────────────────────────────────────────*/
class TemplateChooserModal extends FuzzySuggestModal<string> {
	private paths: string[];
	private onChoose: (path: string) => void;

	constructor(app: any, paths: string[], onChoose: (path: string) => void) {
		super(app);
		this.paths = paths;
		this.onChoose = onChoose;
		this.setPlaceholder("Choose a template...");
		this.modalEl.addClass("four-winds-modal");
	}

	getItems(): string[] {
		return this.paths;
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string): void {
		this.onChoose(item);
	}
}

/*──────────────────────────────────────────────
   Tag Suggest Modal (for adding tags in seeds)
──────────────────────────────────────────────*/
class TagSuggestModal extends FuzzySuggestModal<string> {
	private tagList: string[];
	private callback: (tag: string) => void;

	constructor(app: any, tags: string[], callback: (tag: string) => void) {
		super(app);
		this.tagList = tags;
		this.callback = callback;
		this.setPlaceholder("Type to search or create a tag...");
		this.modalEl.addClass("four-winds-modal");

		// Allow Enter to commit custom input when no exact match selected
		this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				const val = this.inputEl.value.trim();
				// If the typed value isn't in the list, treat it as a new tag
				if (val && !this.tagList.includes(val)) {
					e.preventDefault();
					e.stopPropagation();
					this.close();
					this.callback(val);
				}
			}
		});
	}

	getItems(): string[] {
		return this.tagList;
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string): void {
		this.callback(item);
	}
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	private callback: (folder: TFolder) => void;

	constructor(app: any, callback: (folder: TFolder) => void) {
		super(app);
		this.callback = callback;
		this.setPlaceholder("Choose a folder...");
		this.modalEl.addClass("four-winds-modal");
	}

	getItems(): TFolder[] {
		const folders: TFolder[] = [];
		this.app.vault.getAllLoadedFiles().forEach((f: any) => {
			if (f instanceof TFolder) folders.push(f);
		});
		return folders.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(item: TFolder): string {
		return item.path || "/";
	}

	onChooseItem(item: TFolder): void {
		this.callback(item);
	}
}

/*──────────────────────────────────────────────
   Confirm Modal
──────────────────────────────────────────────*/
class ConfirmModal extends Modal {
	private title: string;
	private message: string;
	private onConfirm: () => void;

	constructor(app: any, title: string, message: string, onConfirm: () => void) {
		super(app);
		this.title = title;
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("four-winds-confirm-modal");
		contentEl.createEl("h3", { text: this.title });
		contentEl.createEl("p", { text: this.message });

		const btnRow = contentEl.createDiv({ cls: "four-winds-confirm-actions" });
		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const confirmBtn = btnRow.createEl("button", { text: "Confirm", cls: "mod-warning" });
		confirmBtn.addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

/*──────────────────────────────────────────────
   Seeds Modal
──────────────────────────────────────────────*/
class SeedsModal extends Modal {
	private plugin: FourWindsPlugin;
	private allFiles: TFile[];
	private cards: TFile[];
	private index: number;
	private deletedStack: TFile[];
	private swipeHandler: SwipeHandler | null = null;
	private keyHandler: (e: KeyboardEvent) => void;
	private isAnimating: boolean = false;

	private activeTagFilter: string;
	private activeSortMode: SeedSortMode;

	private cardEl: HTMLElement;
	private counterEl: HTMLElement;
	private filterBarEl: HTMLElement;

	constructor(app: any, plugin: FourWindsPlugin) {
		super(app);
		this.plugin = plugin;
		this.allFiles = [];
		this.cards = [];
		this.index = 0;
		this.deletedStack = [];
		this.activeTagFilter = "";
		this.activeSortMode = plugin.settings.seedSortMode;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.addClass("four-winds-seeds-modal");
		this.modalEl.addClass("four-winds-modal");

		this.allFiles = gatherFiles(this.app, this.plugin.settings.seedDirectories);
		if (this.allFiles.length === 0) {
			contentEl.createEl("p", { text: "No seeds found in configured directories." });
			return;
		}

		// Filter bar
		this.filterBarEl = contentEl.createDiv({ cls: "four-winds-filter-bar" });
		this.renderFilterBar();

		// Apply initial sort
		this.applyFilterAndSort();

		// Counter
		this.counterEl = contentEl.createDiv({ cls: "four-winds-counter" });

		// Card area
		this.cardEl = contentEl.createDiv({ cls: "four-winds-card" });

		// Action buttons
		const actions = contentEl.createDiv({ cls: "four-winds-actions" });

		const trashBtn = actions.createEl("button", { cls: "four-winds-btn four-winds-btn-trash" });
		trashBtn.setText("Delete");
		trashBtn.createEl("span", { cls: "four-winds-kbd", text: "←" });
		trashBtn.addEventListener("click", () => this.swipeLeft());

		const undoBtn = actions.createEl("button", { cls: "four-winds-btn four-winds-btn-undo" });
		undoBtn.setText("Undo");
		undoBtn.createEl("span", { cls: "four-winds-kbd", text: "Z" });
		undoBtn.addEventListener("click", () => this.undo());

		const skipBtn = actions.createEl("button", { cls: "four-winds-btn four-winds-btn-skip" });
		skipBtn.setText("Skip");
		// Show Space as the canonical skip key — matches DiscoveryModal. The
		// right-arrow / swipe-right gesture still works for muscle memory.
		skipBtn.createEl("span", { cls: "four-winds-kbd", text: "␣" });
		skipBtn.addEventListener("click", () => this.swipeRight());

		const moveBtn = actions.createEl("button", { cls: "four-winds-btn four-winds-btn-move" });
		moveBtn.setText("Move");
		moveBtn.createEl("span", { cls: "four-winds-kbd", text: "↓" });
		moveBtn.addEventListener("click", () => this.moveFile());

		const processBtn = actions.createEl("button", { cls: "four-winds-btn four-winds-btn-process" });
		processBtn.setText("Process");
		processBtn.createEl("span", { cls: "four-winds-kbd", text: "↑" });
		processBtn.addEventListener("click", () => this.processSeed());

		// Keyboard shortcuts
		this.keyHandler = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			switch (e.key) {
				case "ArrowLeft":
					e.preventDefault();
					this.swipeLeft();
					break;
				case "ArrowRight":
				case " ":
					// Space skips for parity with DiscoveryModal. Right-arrow
					// remains bound to match the swipe-right gesture.
					e.preventDefault();
					this.swipeRight();
					break;
				case "ArrowUp":
					e.preventDefault();
					this.processSeed();
					break;
				case "ArrowDown":
					e.preventDefault();
					this.moveFile();
					break;
				case "z":
				case "Z":
					e.preventDefault();
					this.undo();
					break;
				case "o":
				case "O":
					e.preventDefault();
					this.openFile();
					break;
			}
		};
		document.addEventListener("keydown", this.keyHandler);

		await this.renderCard();
	}

	onClose() {
		this.swipeHandler?.destroy();
		document.removeEventListener("keydown", this.keyHandler);

		// Trash deleted files with confirmation for bulk deletes
		if (this.deletedStack.length > 0) {
			const count = this.deletedStack.length;
			if (count > 5) {
				new ConfirmModal(
					this.app,
					`Trash ${count} seeds?`,
					`You marked ${count} seed(s) for deletion. This will move them to trash. Continue?`,
					() => {
						new Notice(`Trashing ${count} seed(s)...`);
						for (const f of this.deletedStack) {
							this.app.vault.trash(f, false);
						}
					}
				).open();
			} else {
				new Notice(`Trashing ${count} seed(s)...`);
				for (const f of this.deletedStack) {
					this.app.vault.trash(f, false);
				}
			}
		}
	}

	private renderFilterBar() {
		this.filterBarEl.empty();

		// Tag filter dropdown
		const allTags = new Set<string>();
		for (const f of this.allFiles) {
			for (const t of getFileTags(this.app, f)) allTags.add(t);
		}
		// Also include configured seed tags
		for (const t of this.plugin.settings.seedTags) {
			if (t) allTags.add(t);
		}

		const tagSelect = this.filterBarEl.createEl("select", { cls: "four-winds-filter-select" });
		tagSelect.createEl("option", { text: "All tags", attr: { value: "" } });
		for (const tag of [...allTags].sort()) {
			const opt = tagSelect.createEl("option", { text: tag, attr: { value: tag } });
			if (tag === this.activeTagFilter) opt.selected = true;
		}
		tagSelect.addEventListener("change", () => {
			this.activeTagFilter = tagSelect.value;
			this.applyFilterAndSort();
			this.index = 0;
			this.renderCard();
		});

		// Sort dropdown
		const sortSelect = this.filterBarEl.createEl("select", { cls: "four-winds-filter-select" });
		const sortOptions: { val: SeedSortMode; label: string }[] = [
			{ val: "shuffle", label: "Shuffle" },
			{ val: "cday", label: "Created (oldest)" },
			{ val: "mday", label: "Modified (newest)" },
			{ val: "tag", label: "By tag" },
		];
		for (const so of sortOptions) {
			const opt = sortSelect.createEl("option", { text: so.label, attr: { value: so.val } });
			if (so.val === this.activeSortMode) opt.selected = true;
		}
		sortSelect.addEventListener("change", () => {
			this.activeSortMode = sortSelect.value as SeedSortMode;
			this.applyFilterAndSort();
			this.index = 0;
			this.renderCard();
		});
	}

	private applyFilterAndSort() {
		this.cards = sortFiles(this.allFiles, this.activeSortMode, this.app, this.activeTagFilter || undefined);
	}

	private async renderCard() {
		if (this.index >= this.cards.length) {
			this.cardEl.empty();
			const msg = this.cards.length === 0 ? "No seeds match the current filter." : "All seeds processed!";
			this.cardEl.createEl("p", { cls: "four-winds-done", text: msg });
			this.updateCounter();
			return;
		}

		this.cardEl.empty();
		this.swipeHandler?.destroy();

		const file = this.cards[this.index];
		const content = await this.app.vault.cachedRead(file);
		const tags = getFileTags(this.app, file);

		// Title
		this.cardEl.createEl("h3", { text: file.basename, cls: "four-winds-card-title" });

		// Tag pills
		const tagContainer = this.cardEl.createDiv({ cls: "four-winds-tags" });
		this.renderTags(tagContainer, tags, file);

		// Content preview — render the note as-is
		const previewEl = this.cardEl.createDiv({ cls: "four-winds-card-preview" });
		const previewText = content;
		await MarkdownRenderer.renderMarkdown(previewText, previewEl, file.path, this.plugin);

		// Swipe handler
		this.swipeHandler = new SwipeHandler({
			el: this.cardEl,
			horizontalOnly: true,
			onSwipe: (dir) => {
				if (dir === "left") this.swipeLeft();
				else if (dir === "right") this.swipeRight();
			},
			onMove: (dx) => {
				this.cardEl.style.transform = `translateX(${dx}px) rotate(${dx * 0.05}deg)`;
				this.cardEl.style.opacity = `${1 - Math.abs(dx) / 400}`;
			},
		});

		this.updateCounter();
	}

	private renderTags(container: HTMLElement, tags: string[], file: TFile) {
		container.empty();
		for (const tag of tags) {
			const pill = container.createEl("span", { cls: "four-winds-tag", text: tag });
			pill.addEventListener("click", async (e) => {
				e.stopPropagation();
				e.preventDefault();
				await this.app.fileManager.processFrontMatter(file, (fm: any) => {
					if (Array.isArray(fm.tags)) {
						fm.tags = fm.tags.filter((t: string) => t !== tag);
					}
				});
				// Re-read tags from file to stay in sync
				const freshTags = getFileTags(this.app, file);
				this.renderTags(container, freshTags, file);
			});
		}
		const addBtn = container.createEl("span", { cls: "four-winds-tag four-winds-tag-add", text: "+" });
		addBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			// Replace "+" with inline select + text input
			addBtn.style.display = "none";

			const allTags = getAllVaultTags(this.app);
			for (const t of this.plugin.settings.seedTags) {
				if (t && !allTags.includes(t)) allTags.push(t);
			}
			const available = allTags.filter((t) => !tags.includes(t));

			const wrapper = container.createDiv({ cls: "four-winds-tag-add-wrapper" });

			const select = wrapper.createEl("select", { cls: "four-winds-tag-select" });
			select.createEl("option", { text: "Select tag...", attr: { value: "" } });
			for (const t of available) {
				select.createEl("option", { text: t, attr: { value: t } });
			}
			select.createEl("option", { text: "— Type new —", attr: { value: "__new__" } });

			const applyTag = async (val: string) => {
				if (val) {
					await this.app.fileManager.processFrontMatter(file, (fm: any) => {
						if (!fm.tags) fm.tags = [];
						if (!Array.isArray(fm.tags)) fm.tags = [fm.tags];
						if (!fm.tags.includes(val)) fm.tags.push(val);
					});
				}
				// Re-read tags from file to stay in sync
				const freshTags = getFileTags(this.app, file);
				this.renderTags(container, freshTags, file);
			};

			select.addEventListener("change", () => {
				const val = select.value;
				if (val === "__new__") {
					select.style.display = "none";
					const input = wrapper.createEl("input", {
						cls: "four-winds-tag-input",
						attr: { type: "text", placeholder: "new tag..." },
					});
					input.focus();
					const commit = () => applyTag(input.value.trim());
					input.addEventListener("keydown", (ev) => {
						if (ev.key === "Enter") commit();
						if (ev.key === "Escape") this.renderTags(container, tags, file);
					});
					input.addEventListener("blur", commit);
				} else if (val) {
					applyTag(val);
				}
			});

			select.focus();

			// Cancel on Escape
			select.addEventListener("keydown", (ev) => {
				if (ev.key === "Escape") this.renderTags(container, tags, file);
			});
		});
	}

	private updateCounter() {
		const remaining = this.cards.length - this.index;
		this.counterEl.setText(`${this.index} of ${this.cards.length} · ${remaining} remaining`);
	}

	private swipeLeft() {
		if (this.isAnimating || this.index >= this.cards.length) return;
		this.isAnimating = true;
		this.cardEl.addClass("four-winds-exit-left");
		const file = this.cards[this.index];
		this.deletedStack.push(file);
		setTimeout(() => {
			this.cardEl.removeClass("four-winds-exit-left");
			this.cardEl.style.transform = "";
			this.cardEl.style.opacity = "";
			this.index++;
			this.isAnimating = false;
			this.renderCard();
		}, 250);
	}

	private swipeRight() {
		if (this.isAnimating || this.index >= this.cards.length) return;
		this.isAnimating = true;
		this.cardEl.addClass("four-winds-exit-right");
		setTimeout(() => {
			this.cardEl.removeClass("four-winds-exit-right");
			this.cardEl.style.transform = "";
			this.cardEl.style.opacity = "";
			this.index++;
			this.isAnimating = false;
			this.renderCard();
		}, 250);
	}

	private undo() {
		if (this.deletedStack.length === 0) {
			new Notice("Nothing to undo");
			return;
		}
		const restored = this.deletedStack.pop()!;
		this.cards.splice(this.index, 0, restored);
		new Notice(`Restored "${restored.basename}"`);
		this.renderCard();
	}

	private async moveFile() {
		if (this.isAnimating || this.index >= this.cards.length) return;
		const file = this.cards[this.index];

		new FolderSuggestModal(this.app, async (folder: TFolder) => {
			const newPath = `${folder.path}/${file.name}`;
			await this.app.fileManager.renameFile(file, newPath);
			new Notice(`Moved "${file.basename}" → ${folder.path}`);
			this.index++;
			this.renderCard();
		}).open();
	}

	private async openFile() {
		if (this.isAnimating || this.index >= this.cards.length) return;
		const file = this.cards[this.index];
		this.close();
		await this.app.workspace.openLinkText(file.path, "", false);
	}

	private async processSeed() {
		if (this.isAnimating || this.index >= this.cards.length) return;
		const settings = this.plugin.settings;
		const validTemplates = settings.templates.filter((t: any) => t.path);
		console.log("[Four Winds] processSeed called, templates:", validTemplates.length);

		if (validTemplates.length === 0) {
			new Notice("No templates configured — add one in Four Winds settings");
			return;
		}

		if (validTemplates.length === 1) {
			await this.executeProcess(validTemplates[0]);
		} else {
			// Multiple templates — let user pick
			new TemplateChooserModal(
				this.app,
				validTemplates.map((t: any) => t.path),
				(chosen) => {
					const tmpl = validTemplates.find((t: any) => t.path === chosen);
					if (tmpl) {
						this.executeProcess(tmpl).catch((err) => {
							console.error("[Four Winds] executeProcess error from chooser:", err);
							new Notice("Process failed: " + err.message);
						});
					}
				}
			).open();
		}
	}

	private async executeProcess(template: { path: string; captureHeading: string; captureFormat: string; destinationFolder: string }) {
		console.log("[Four Winds] executeProcess called", template.path);
	  try {
		const seedFile = this.cards[this.index];
		const seedContent = await this.app.vault.cachedRead(seedFile);
		const settings = this.plugin.settings;

		// 1. Extract the seed:: capture value
		const capture = extractSeedCapture(seedContent, settings.seedField);
		const title = seedFile.basename;

		// 2. Verify template exists
		const templateFile = this.app.vault.getAbstractFileByPath(template.path);
		if (!(templateFile instanceof TFile)) {
			new Notice("Template not found: " + template.path);
			return;
		}

		// 3. Move seed to destination folder (if configured)
		const destFolder = template.destinationFolder || (seedFile.parent?.path ?? "");
		let movedFile = seedFile;
		if (destFolder && seedFile.parent?.path !== destFolder) {
			const destFolderObj = this.app.vault.getAbstractFileByPath(destFolder);
			if (destFolderObj instanceof TFolder) {
				const newPath = `${destFolder}/${seedFile.name}`;
				await this.app.fileManager.renameFile(seedFile, newPath);
				const moved = this.app.vault.getAbstractFileByPath(newPath);
				if (moved instanceof TFile) movedFile = moved;
			} else {
				new Notice(`Destination folder not found: ${destFolder}`);
			}
		}

		// 4. Read template and replace Obsidian core template placeholders
		let content = await this.app.vault.read(templateFile as TFile);
		const now = (window as any).moment();

		// Replace {{date:FORMAT}} placeholders (Obsidian core Templates syntax)
		content = content.replace(/\{\{date(?::([^}]+))?\}\}/g, (_: string, fmt: string) => {
			return now.format(fmt || "YYYY-MM-DD");
		});

		// Replace {{time:FORMAT}} placeholders
		content = content.replace(/\{\{time(?::([^}]+))?\}\}/g, (_: string, fmt: string) => {
			return now.format(fmt || "HH:mm");
		});

		// Replace {{title}} with the seed note's name
		content = content.replace(/\{\{title\}\}/g, title);

		// 5. Overwrite the seed file with processed template content
		await this.app.vault.modify(movedFile, content);

		// 6. If template has Templater <% %> tokens, process them
		if (content.includes("<%")) {
			const templater = (this.app as any).plugins.getPlugin("templater-obsidian");
			if (templater) {
				try {
					await templater.templater.overwrite_file_commands(movedFile, true);
				} catch (err) {
					console.error("Templater processing failed:", err);
				}
			}
		}

		// 7. Insert capture under heading
		if (capture && template.captureHeading) {
			// Re-read file after Templater may have modified it
			let finalContent = await this.app.vault.read(movedFile);
			const heading = template.captureHeading;

			const dateStr = now.format("YYYY-MM-DD");
			const timeStr = now.format("HH:mm");
			const formattedCapture = template.captureFormat
				.replace(/\{title\}/g, title)
				.replace(/\{date\}/g, dateStr)
				.replace(/\{time\}/g, timeStr)
				.replace(/\{capture\}/g, capture);

			const headingRegex = new RegExp(`^(#{1,6}\\s+${escapeRegExpStr(heading)}.*)$`, "m");
			const hMatch = headingRegex.exec(finalContent);
			if (hMatch) {
				const insertPos = hMatch.index + hMatch[0].length;
				finalContent =
					finalContent.slice(0, insertPos) +
					"\n" + formattedCapture +
					finalContent.slice(insertPos);
				await this.app.vault.modify(movedFile, finalContent);
			}
		}

		// 8. Close modal and open the processed note
		this.close();
		await this.app.workspace.openLinkText(movedFile.path, "", false);

		// 9. Stella integration — directly access Stella plugin and add note to context
		if (settings.stellaOnProcess) {
			const stella = (this.app as any).plugins.getPlugin("stella");
			if (stella) {
				const leaves = this.app.workspace.getLeavesOfType("stella-mcp-chat-view");
				if (leaves.length === 0) {
					await stella.activateView();
				}
				const stellaLeaves = this.app.workspace.getLeavesOfType("stella-mcp-chat-view");
				if (stellaLeaves.length > 0) {
					this.app.workspace.revealLeaf(stellaLeaves[0]);
					const chatView = stellaLeaves[0].view as any;
					chatView.startNewConversation();
					chatView.contextNotes = [];
					if (chatView.addNoteToContext) {
						await chatView.addNoteToContext(movedFile);
					}
				}
			} else {
				new Notice("Stella plugin not found");
			}
		}
	  } catch (err) {
		console.error("[Four Winds] executeProcess error:", err);
		new Notice("Process failed: " + (err as Error).message);
	  }
	}
}

/*──────────────────────────────────────────────
   Shared cytoscape graph helpers
   Used by both NavigationView and the Discovery card-back mini graph so
   the two always look and lay out the same.
──────────────────────────────────────────────*/
// Layout slot is fixed by role, regardless of what the user has renamed the
// role's tag to. Parent always sits north, child south, supportive sibling
// east, challenging sibling west.
const ROLE_TO_LAYOUT_DIR: Record<Role, string> = {
	parent: "north",
	child: "south",
	supportive_sibling: "east",
	challenging_sibling: "west",
};

// Per-direction node colors — a hard user requirement; keep them in sync
// with the frame edge-label colors in styles.css.
const DIRECTION_COLORS: Record<string, string> = {
	north: "#607c87",
	east: "#76b12b",
	south: "#c7b194",
	west: "#f0533f",
};

// Labels wrap at this width (cytoscape text-max-width); position math uses
// the same cap when estimating label boxes.
const LABEL_MAX_WIDTH = 140;

// Direction-aware initial placement. Positions are NOT clamped to the
// container — each node gets enough room for its (wrapped) label and the
// layout grows as needed; callers fit the camera afterwards, so a crowded
// compass spreads out instead of overlapping.
function calculateNodePositions(
	direction: string,
	nodeCount: number,
	centerX: number,
	centerY: number,
	containerWidth: number,
	containerHeight: number,
	labels?: string[]
): Array<{ x: number; y: number }> {
	const positions: Array<{ x: number; y: number }> = [];
	const dir = direction.toLowerCase();
	const isLateral = dir === "east" || dir === "west";

	// Label dimensions. Width is capped because labels wrap; rows are
	// tall enough for a two-line wrapped label.
	const charWidth = 7;
	const labelWidths = labels
		? labels.map((l) => Math.min(l.length * charWidth + 16, LABEL_MAX_WIDTH))
		: Array(nodeCount).fill(60);

	const halfW = containerWidth / 2;
	const halfH = containerHeight / 2;

	if (isLateral) {
		// East/West: primary axis = x (pushed out into the half), nodes
		// stacked vertically with a guaranteed per-row gap.
		const xSign = dir === "east" ? 1 : -1;
		const xBase = halfW * 0.45;
		const xRange = halfW * 0.35;
		const rowGap = 38;
		const startY = centerY - ((nodeCount - 1) * rowGap) / 2;

		for (let i = 0; i < nodeCount; i++) {
			// Stagger x outward: alternate near/far so neighboring labels
			// also separate horizontally.
			const xDepth = nodeCount <= 1 ? 0.5
				: (i % 2 === 0 ? 0.2 : 0.8);
			positions.push({
				x: centerX + xSign * (xBase + xDepth * xRange),
				y: startY + i * rowGap,
			});
		}
	} else {
		// North/South: primary axis = y. Nodes alternate between a near
		// and a far tier; each tier is packed independently by actual
		// label width so labels in the same tier can never collide, and
		// the tier separation keeps cross-tier labels apart.
		const ySign = dir === "south" ? 1 : -1;
		const yBase = halfH * 0.45;
		const yRange = halfH * 0.35;
		const gap = 18;

		const tiers: number[][] = [[], []];
		for (let i = 0; i < nodeCount; i++) tiers[i % 2].push(i);

		const xs: number[] = new Array(nodeCount).fill(centerX);
		for (const tier of tiers) {
			if (!tier.length) continue;
			const total = tier.reduce((s, idx) => s + labelWidths[idx], 0) + gap * (tier.length - 1);
			let cur = centerX - total / 2;
			for (const idx of tier) {
				xs[idx] = cur + labelWidths[idx] / 2;
				cur += labelWidths[idx] + gap;
			}
		}

		for (let i = 0; i < nodeCount; i++) {
			const yDepth = nodeCount <= 1 ? 0.5
				: (i % 2 === 0 ? 0.2 : 0.8);
			positions.push({
				x: xs[i],
				y: centerY + ySign * (yBase + yDepth * yRange),
			});
		}
	}

	return positions;
}

// Push overlapping labels apart. Per-direction placement can't see other
// branches' clusters (or the primaries' labels), so after placement we
// resolve collisions globally: every node's RENDERED bounding box (label
// included, via cytoscape's boundingBox) is treated as solid, and
// overlapping pairs are pushed apart along the axis of least penetration.
// Nodes in `fixed` never move; when two movable nodes collide each takes
// half the push. Iterates until stable.
function resolveLabelOverlaps(
	movable: cytoscape.NodeCollection,
	fixed: cytoscape.NodeCollection
) {
	if (movable.length === 0) return;
	const pad = 8;
	const movableIds = new Set(movable.map((n) => n.id()));
	const nodes: cytoscape.NodeSingular[] = movable.union(fixed).nodes().toArray();

	for (let iter = 0; iter < 50; iter++) {
		let moved = false;
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				const a = nodes[i];
				const b = nodes[j];
				const aMov = movableIds.has(a.id());
				const bMov = movableIds.has(b.id());
				if (!aMov && !bMov) continue;

				const ba = a.boundingBox({ includeLabels: true });
				const bb = b.boundingBox({ includeLabels: true });
				const overlapX = Math.min(ba.x2, bb.x2) - Math.max(ba.x1, bb.x1) + pad;
				const overlapY = Math.min(ba.y2, bb.y2) - Math.max(ba.y1, bb.y1) + pad;
				if (overlapX <= 0 || overlapY <= 0) continue;
				moved = true;

				// Push along whichever axis needs the smaller shift.
				const axis: "x" | "y" = overlapX < overlapY ? "x" : "y";
				const amount = axis === "x" ? overlapX : overlapY;
				// a goes negative-ward if it's on the negative side of b.
				const aSign = a.position()[axis] <= b.position()[axis] ? -1 : 1;

				if (aMov && bMov) {
					a.position(axis, a.position(axis) + aSign * amount / 2);
					b.position(axis, b.position(axis) - aSign * amount / 2);
				} else if (aMov) {
					a.position(axis, a.position(axis) + aSign * amount);
				} else {
					b.position(axis, b.position(axis) - aSign * amount);
				}
			}
		}
		if (!moved) break;
	}
}

// Shared stylesheet for compass graphs: wrapped labels, the central node,
// the four direction-colored branch selectors, and the base edge style.
// Views append their own extras (secondary/tertiary/mutual/cross).
function baseGraphStyles(opts: {
	centralSize: number;
	branchSize: number;
	centralFont: number;
	branchFont: number;
}): any[] {
	const dirStyle = (dir: string, valign: "top" | "bottom") => ({
		selector: `node[type="branch"][direction="${dir}"]`,
		style: {
			"background-color": DIRECTION_COLORS[dir],
			width: `${opts.branchSize}px`,
			height: `${opts.branchSize}px`,
			label: "data(label)",
			"text-valign": valign,
			"text-halign": "center",
			"text-margin-y": valign === "top" ? -10 : 10,
			"font-size": `${opts.branchFont}px`,
			color: "#fff",
		},
	});
	return [
		{
			// Base label behavior for every node: wrap long titles instead
			// of letting them run into neighboring labels.
			selector: "node",
			style: {
				"text-wrap": "wrap",
				"text-max-width": `${LABEL_MAX_WIDTH}px`,
			},
		},
		{
			selector: 'node[type="central"]',
			style: {
				"background-color": "#c7b194",
				width: `${opts.centralSize}px`,
				height: `${opts.centralSize}px`,
				label: "data(label)",
				"text-valign": "bottom",
				"text-halign": "center",
				"text-margin-y": 10,
				"font-size": `${opts.centralFont}px`,
				"font-weight": "bold",
				color: "#fff",
			},
		},
		dirStyle("north", "top"),
		dirStyle("east", "bottom"),
		dirStyle("south", "bottom"),
		dirStyle("west", "top"),
		{
			selector: "edge",
			style: {
				width: "0.5px",
				"line-color": "#917959",
				"target-arrow-shape": "triangle",
				"target-arrow-color": "#917959",
				"source-arrow-shape": "none",
				"arrow-scale": 0.6,
				"curve-style": "bezier",
				opacity: 0.5,
			},
		},
	];
}

/*──────────────────────────────────────────────
   Discovery Modal
──────────────────────────────────────────────*/
class DiscoveryModal extends Modal {
	private plugin: FourWindsPlugin;
	private cards: TFile[];
	private index: number;
	private swipeHandler: SwipeHandler | null = null;
	private cy: cytoscape.Core | null = null;
	private flipped = false;
	// Mirrors the seed processor's guard (2026-04-16 incident): blocks
	// pointer-spam during the swipe-exit animation so a held / repeated
	// swipe can't mis-link the same card or skip the next one.
	private isAnimating = false;
	// Files queued for trashing on modal close (Seeds-style undo). Actual
	// trashing happens in onClose with a ConfirmModal when count > 5.
	private deletedStack: TFile[] = [];

	private cardEl: HTMLElement;
	private counterEl: HTMLElement;
	private innerEl: HTMLElement | null = null;
	private graphContainerEl: HTMLElement | null = null;
	private cardContent = "";
	private keyHandler: (e: KeyboardEvent) => void = () => {};

	constructor(app: any, plugin: FourWindsPlugin) {
		super(app);
		this.plugin = plugin;
		this.cards = [];
		this.index = 0;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("four-winds-discovery-modal");
		this.modalEl.addClass("four-winds-modal");
		this.modalEl.addClass("four-winds-discovery-shell");

		const allFiles = gatherFiles(this.app, this.plugin.settings.discoveryDirectories);
		if (allFiles.length === 0) {
			contentEl.createEl("p", { text: "No notes found in configured directories." });
			return;
		}
		this.cards = shuffle(allFiles);

		this.counterEl = contentEl.createDiv({ cls: "four-winds-counter" });

		// Frame: rectangular layout with role/key labels on the four edges
		// surrounding the card. Labels read from settings.directionNames +
		// settings.discoveryKeys so renamed roles + rebound keys both reflect.
		const frame = contentEl.createDiv({ cls: "four-winds-frame" });
		const settings = this.plugin.settings;
		const keyGlyph = (k: string) => {
			if (!k) return "?";
			const lower = k.toLowerCase();
			const arrows: Record<string, string> = {
				arrowup: "↑", arrowright: "→", arrowdown: "↓", arrowleft: "←",
			};
			if (lower in arrows) return arrows[lower];
			return k.length === 1 ? k.toUpperCase() : k;
		};
		const edgeLabel = (role: Role, edgeCls: string, arrow: string) => {
			const raw = settings.directionNames[role] || DEFAULT_DIRECTION_NAMES[role];
			const name = raw.charAt(0).toUpperCase() + raw.slice(1);
			const key = settings.discoveryKeys[role] || DEFAULT_DISCOVERY_KEYS[role];
			const wrap = frame.createDiv({ cls: `four-winds-edge ${edgeCls}` });
			wrap.createEl("span", { cls: "four-winds-edge-arrow", text: arrow });
			wrap.createEl("span", { cls: "four-winds-edge-name", text: name });
			wrap.createEl("span", { cls: "four-winds-edge-key", text: keyGlyph(key) });
		};
		edgeLabel("parent", "four-winds-edge-n", "↑");
		edgeLabel("supportive_sibling", "four-winds-edge-e", "→");
		edgeLabel("child", "four-winds-edge-s", "↓");
		edgeLabel("challenging_sibling", "four-winds-edge-w", "←");

		// Help button on the frame — toggles the action-keys legend popover.
		// The legend covers non-configurable action keys (open / delete /
		// flip / undo) which used to sit in an always-visible bottom bar but
		// got clipped on shorter viewports. Click the "?" to peek at them.
		const helpBtn = frame.createDiv({
			cls: "four-winds-help-btn",
			text: "?",
			attr: { "aria-label": "Show controls", title: "Show controls (?)", role: "button", tabindex: "0" },
		});

		this.cardEl = frame.createDiv({ cls: "four-winds-discovery-card" });

		// Action-keys legend — popover anchored under the help button. Hidden
		// by default; toggled by `?` key or the help button. Lives inside the
		// frame so it positions relative to the button.
		const controls = frame.createDiv({ cls: "four-winds-controls-bar" });
		const addControl = (key: string, label: string) => {
			const item = controls.createDiv({ cls: "four-winds-control-item" });
			item.createEl("span", { cls: "four-winds-control-key", text: key });
			item.createEl("span", { cls: "four-winds-control-label", text: label });
		};
		addControl("O", "Open");
		addControl("D", "Delete");
		addControl("F", "Flip");
		addControl("Z", "Undo");
		addControl("␣", "Skip");

		const toggleControls = () => {
			const isOpen = controls.classList.toggle("is-open");
			helpBtn.classList.toggle("is-active", isOpen);
		};
		helpBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			toggleControls();
			// The div has tabindex=0, so a mouse click leaves it focused. If
			// focus stayed, every later Space/Enter (skip etc.) would also
			// hit this button's keydown handler and re-toggle the legend —
			// the "randomly blinking" bug. Keyboard users still reach it via
			// Tab, which doesn't go through here.
			helpBtn.blur();
		});
		helpBtn.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				// Don't let the document-level handler ALSO treat this Space
				// as "skip card".
				e.stopPropagation();
				toggleControls();
			}
		});

		// Keyboard: configurable direction keys + baked-in action keys.
		// Mirrors SeedsModal's pattern (input-field guard + e.preventDefault).
		this.keyHandler = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			const key = e.key.toLowerCase();
			for (const role of ROLES) {
				const bound = (this.plugin.settings.discoveryKeys[role] || DEFAULT_DISCOVERY_KEYS[role]).toLowerCase();
				if (key === bound) {
					e.preventDefault();
					this.linkAsRole(role);
					return;
				}
			}
			switch (key) {
				case "o":
					e.preventDefault();
					this.openCard();
					return;
				case "d":
					e.preventDefault();
					this.deleteCard();
					return;
				case "f":
					e.preventDefault();
					this.toggleFlip();
					return;
				case "z":
					e.preventDefault();
					this.undo();
					return;
				case " ":
					e.preventDefault();
					this.skipCard();
					return;
				case "?":
				case "/":
					e.preventDefault();
					toggleControls();
					return;
			}
		};
		document.addEventListener("keydown", this.keyHandler);

		await this.renderCard();
	}

	onClose() {
		this.swipeHandler?.destroy();
		document.removeEventListener("keydown", this.keyHandler);
		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}

		// Trash deleted files. Mirrors SeedsModal: bulk-confirm beyond 5 to
		// avoid the held-key-spam disaster mode (2026-04-16 incident).
		if (this.deletedStack.length > 0) {
			const count = this.deletedStack.length;
			const doTrash = () => {
				new Notice(`Trashing ${count} note(s)...`);
				for (const f of this.deletedStack) {
					this.app.vault.trash(f, false);
				}
			};
			if (count > 5) {
				new ConfirmModal(
					this.app,
					`Trash ${count} notes?`,
					`You marked ${count} note(s) for deletion during Discovery. This will move them to trash. Continue?`,
					doTrash,
				).open();
			} else {
				doTrash();
			}
		}
	}

	private async renderCard() {
		if (this.index >= this.cards.length) {
			this.cardEl.empty();
			this.cardEl.createEl("p", { cls: "four-winds-done", text: "No more notes to discover!" });
			this.updateCounter();
			this.innerEl = null;
			this.graphContainerEl = null;
			return;
		}

		this.cardEl.empty();
		this.swipeHandler?.destroy();
		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}
		this.flipped = false;
		this.cardEl.removeClass("four-winds-flipped");

		const file = this.cards[this.index];
		const content = await this.app.vault.cachedRead(file);
		this.cardContent = content;

		// Card inner (for 3D flip)
		const inner = this.cardEl.createDiv({ cls: "four-winds-card-inner" });
		this.innerEl = inner;

		// Front face — title + scrollable preview. Direction arrows live on
		// the surrounding frame edges, not on the card.
		const front = inner.createDiv({ cls: "four-winds-card-face four-winds-card-front" });
		front.createEl("h3", { text: file.basename, cls: "four-winds-card-title" });
		const previewScroll = front.createDiv({ cls: "four-winds-preview-scroll" });
		await MarkdownRenderer.renderMarkdown(content, previewScroll, file.path, this.plugin);

		// Back face — the graph fills the whole card (no heading; the central
		// node already carries the note's name).
		const back = inner.createDiv({ cls: "four-winds-card-face four-winds-card-back" });
		const graphContainer = back.createDiv({ cls: "four-winds-graph-container" });
		this.graphContainerEl = graphContainer;

		// Swipe handler (touch / pointer drag). Keyboard input goes through
		// onOpen's document-level keydown listener.
		this.swipeHandler = new SwipeHandler({
			el: this.cardEl,
			horizontalOnly: false,
			onSwipe: (dir) => this.handleSwipe(dir, file),
			onTap: () => this.flipCard(inner, graphContainer, file, content),
			onMove: (dx, dy) => {
				if (!this.flipped) {
					this.cardEl.style.transform = `translate(${dx}px, ${dy}px)`;
					this.cardEl.style.opacity = `${1 - (Math.abs(dx) + Math.abs(dy)) / 600}`;
				}
			},
		});

		this.updateCounter();
	}

	private flipCard(inner: HTMLElement, graphContainer: HTMLElement, file: TFile, content: string) {
		this.flipped = !this.flipped;
		if (this.flipped) {
			this.cardEl.addClass("four-winds-flipped");
			// Render cytoscape after flip transition
			const handler = () => {
				inner.removeEventListener("transitionend", handler);
				this.renderMiniGraph(graphContainer, file, content);
			};
			inner.addEventListener("transitionend", handler);
		} else {
			this.cardEl.removeClass("four-winds-flipped");
			if (this.cy) {
				this.cy.destroy();
				this.cy = null;
			}
		}
	}

	private async renderMiniGraph(container: HTMLElement, file: TFile, content: string) {
		container.empty();
		const width = container.clientWidth || 300;
		const height = container.clientHeight || 250;
		const centerX = width / 2;
		const centerY = height / 2;

		const nodes: cytoscape.ElementDefinition[] = [
			{
				data: { id: "center", label: file.basename, type: "central" },
				position: { x: centerX, y: centerY },
			},
		];
		const edges: cytoscape.ElementDefinition[] = [];

		// Same parse, placement, and direction semantics as NavigationView:
		// extractCompassByRole honors renamed role tags and normalizes link
		// forms; calculateNodePositions does the direction-aware, unclamped
		// layout. A note appearing under multiple roles keeps its first slot.
		const compass = extractCompassByRole(content, this.plugin.settings);
		const centerLC = file.basename.toLowerCase();
		const seen = new Set<string>();

		let nodeIdx = 0;
		for (const role of ROLES) {
			const layoutDir = ROLE_TO_LAYOUT_DIR[role];
			const links = Array.from(compass[role]).filter((link) => {
				const lc = link.toLowerCase();
				if (lc === centerLC || seen.has(lc)) return false;
				seen.add(lc);
				return true;
			});
			if (!links.length) continue;

			const positions = calculateNodePositions(
				layoutDir, links.length, centerX, centerY, width, height, links
			);
			links.forEach((linkName, i) => {
				const nid = `n${nodeIdx++}`;
				nodes.push({
					data: { id: nid, label: linkName, type: "branch", direction: layoutDir, role, linkName },
					position: positions[i],
				});
				edges.push({
					data: { source: "center", target: nid },
				});
			});
		}

		const cy = cytoscapeFn({
			container,
			elements: [...nodes, ...edges],
			// Smaller node/font scale than the full Navigation View — this
			// renders inside a card back — but the same direction colors,
			// wrapped labels, and edge treatment.
			style: baseGraphStyles({ centralSize: 20, branchSize: 12, centralFont: 12, branchFont: 10 }),
			layout: { name: "preset" },
			// Panning/zooming stay off: the card's SwipeHandler owns pointer
			// drags (a drag on the flipped card is a swipe-link). fit() below
			// guarantees everything is visible anyway.
			userPanningEnabled: false,
			userZoomingEnabled: false,
			boxSelectionEnabled: false,
		});
		this.cy = cy;

		// Same global de-overlap pass as the Navigation View, then frame
		// the result inside the card.
		resolveLabelOverlaps(cy.nodes('[type="branch"]'), cy.nodes('[type="central"]'));
		if (cy.elements().length > 1) cy.fit(undefined, 24);

		// Branch nodes navigate to the linked note. Close the modal first so
		// the new file lands where intended instead of behind the modal.
		// Shift+tap opens in a split to the right, matching NavigationView.
		const openLink = (linkName: string, mode?: "tab" | "split") => {
			const sourcePath = file.path;
			this.close();
			this.app.workspace.openLinkText(linkName, sourcePath, mode ?? false);
		};

		cy.on("tap", 'node[type="branch"]', (evt: any) => {
			const linkName = evt.target.data("linkName");
			if (!linkName) return;
			const original = evt.originalEvent as MouseEvent | undefined;
			openLink(linkName, original?.shiftKey ? "split" : undefined);
		});

		// Right-click menu. Unlike NavigationView's (open in tab/split), these
		// actions keep the Discovery session alive: background-open leaves the
		// modal up, and Focus pulls the note in as the current card.
		container.addEventListener("contextmenu", (e) => e.preventDefault());
		cy.on("cxttap", 'node[type="branch"]', (evt: any) => {
			const linkName = evt.target.data("linkName");
			if (!linkName) return;
			const original = evt.originalEvent as MouseEvent | undefined;
			const target = this.app.metadataCache.getFirstLinkpathDest(linkName, file.path);
			if (!target) {
				new Notice(`Note not found: ${linkName}`);
				return;
			}
			const menu = new Menu();
			menu.addItem((item) =>
				item.setTitle("Open in background tab")
					.setIcon("file-plus")
					.onClick(async () => {
						await this.app.workspace.getLeaf("tab").openFile(target, { active: false });
						new Notice(`Opened [[${target.basename}]] in background`);
					})
			);
			menu.addItem((item) =>
				item.setTitle("Focus note")
					.setIcon("focus")
					.onClick(() => this.focusNote(target))
			);
			if (original) menu.showAtMouseEvent(original);
		});
		// Pointer cue so users discover the click affordance.
		cy.on("mouseover", 'node[type="branch"]', () => {
			container.style.cursor = "pointer";
		});
		cy.on("mouseout", 'node[type="branch"]', () => {
			container.style.cursor = "";
		});
	}

	// Swipe direction → role. Up/down = parent/child (asymmetric);
	// right/left = supportive/challenging sibling (symmetric).
	private swipeRoleMap: Record<SwipeDirection, Role> = {
		up: "parent",
		right: "supportive_sibling",
		down: "child",
		left: "challenging_sibling",
	};

	// role → SwipeDirection used to pick the exit-animation class. Keeps the
	// visual cue consistent with how the user invoked the action (swipe or
	// key), even when invocation source differs.
	private exitDirForRole(role: Role): SwipeDirection {
		switch (role) {
			case "parent": return "up";
			case "supportive_sibling": return "right";
			case "child": return "down";
			case "challenging_sibling": return "left";
		}
	}

	private async handleSwipe(_dir: SwipeDirection, _file: TFile) {
		await this.linkAsRole(this.swipeRoleMap[_dir]);
	}

	// Shared implementation for swipe + key paths.
	private async linkAsRole(role: Role) {
		if (this.isAnimating || this.index >= this.cards.length) return;
		this.isAnimating = true;

		const file = this.cards[this.index];
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No active file to add link to");
			this.isAnimating = false;
			this.nextCard();
			return;
		}

		const exitDir = this.exitDirForRole(role);
		const exitClass = `four-winds-exit-${exitDir}`;
		this.cardEl.addClass(exitClass);

		const settings = this.plugin.settings;
		const tag = tagFor(settings, role);
		await addLinkToBlock(this.app, activeFile.path, file.basename, tag);

		if (settings.autoLink) {
			const inverseTag = tagFor(settings, INVERSE_ROLE[role]);
			await addLinkToBlock(this.app, file.path, activeFile.basename, inverseTag);
		}

		const displayName = settings.directionNames[role] || DEFAULT_DIRECTION_NAMES[role];
		new Notice(`Linked [[${file.basename}]] as ${displayName}`);

		setTimeout(() => {
			this.cardEl.removeClass(exitClass);
			this.cardEl.style.transform = "";
			this.cardEl.style.opacity = "";
			this.index++;
			this.isAnimating = false;
			this.renderCard();
		}, 300);
	}

	private nextCard() {
		if (this.isAnimating || this.index >= this.cards.length) return;
		this.index++;
		this.cardEl.style.transform = "";
		this.cardEl.style.opacity = "";
		this.renderCard();
	}

	// Advance without linking or trashing. Direction-neutral fade so the
	// motion doesn't read as a role-link or a delete.
	private skipCard() {
		if (this.isAnimating || this.index >= this.cards.length) return;
		this.isAnimating = true;
		this.cardEl.addClass("four-winds-exit-skip");
		setTimeout(() => {
			this.cardEl.removeClass("four-winds-exit-skip");
			this.cardEl.style.transform = "";
			this.cardEl.style.opacity = "";
			this.index++;
			this.isAnimating = false;
			this.renderCard();
		}, 200);
	}

	// Push current card onto deletedStack for batched trashing on close.
	// Animates as a left exit. Z to undo before close.
	private deleteCard() {
		if (this.isAnimating || this.index >= this.cards.length) return;
		this.isAnimating = true;

		const file = this.cards[this.index];
		this.deletedStack.push(file);
		new Notice(`Marked "${file.basename}" for deletion (Z to undo)`);

		this.cardEl.addClass("four-winds-exit-left");
		setTimeout(() => {
			this.cardEl.removeClass("four-winds-exit-left");
			this.cardEl.style.transform = "";
			this.cardEl.style.opacity = "";
			this.index++;
			this.isAnimating = false;
			this.renderCard();
		}, 300);
	}

	private undo() {
		if (this.deletedStack.length === 0) {
			new Notice("Nothing to undo");
			return;
		}
		const restored = this.deletedStack.pop()!;
		// Insert at current index so the restored card is what we land on.
		this.cards.splice(this.index, 0, restored);
		new Notice(`Restored "${restored.basename}"`);
		this.renderCard();
	}

	private async openCard() {
		if (this.isAnimating || this.index >= this.cards.length) return;
		const file = this.cards[this.index];
		this.close();
		await this.app.workspace.openLinkText(file.path, "", false);
	}

	// Make `target` the current Discovery card (right-click → "Focus note"
	// on the card-back graph). If it's already in the remaining deck, move
	// it up instead of duplicating; the card we were on resumes right after.
	// Works for notes outside the discovery folders too — focusing is an
	// explicit ask.
	private focusNote(target: TFile) {
		const existing = this.cards.indexOf(target, this.index);
		if (existing !== -1) this.cards.splice(existing, 1);
		this.cards.splice(this.index, 0, target);
		this.renderCard();
	}

	private toggleFlip() {
		if (this.isAnimating) return;
		if (!this.innerEl || !this.graphContainerEl) return;
		if (this.index >= this.cards.length) return;
		const file = this.cards[this.index];
		this.flipCard(this.innerEl, this.graphContainerEl, file, this.cardContent);
	}

	private updateCounter() {
		const remaining = this.cards.length - this.index;
		this.counterEl.setText(`${this.index + 1} of ${this.cards.length} · ${remaining} remaining`);
	}
}

/*──────────────────────────────────────────────
   1) CompassView (existing)
──────────────────────────────────────────────*/
class CompassView extends ItemView {
	static VIEW_TYPE = "compass-view";

	private plugin: FourWindsPlugin;
	private renderTimeout: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: FourWindsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getIcon(): string {
		return "compass";
	}

	getViewType(): string {
		return CompassView.VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Compass";
	}

	async onOpen(): Promise<void> {
		this.render();
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.handleFileOpen())
		);
	}

	async onClose(): Promise<void> {
		this.cleanupRenderTimeout();
	}

	handleFileOpen() {
		this.cleanupRenderTimeout();
		this.renderTimeout = window.setTimeout(() => {
			this.render();
		}, 300);
	}

	cleanupRenderTimeout() {
		if (this.renderTimeout) {
			clearTimeout(this.renderTimeout);
			this.renderTimeout = null;
		}
	}

	async render() {
		const container = this.containerEl.children[1];
		container.empty();

		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			container.createEl("p", { text: "No active note selected." });
			return;
		}

		try {
			const content = await this.app.vault.cachedRead(activeFile);
			if (!content || content.trim().length === 0) {
				container.createEl("p", { text: "The selected note has no content." });
				return;
			}

			const settings = this.plugin.settings;
			const sections = ROLES.map((role) => ({
				role,
				tag: tagFor(settings, role),
				label: settings.directionNames[role] || DEFAULT_DIRECTION_NAMES[role],
			}));

			const directionLinks: Record<Role, Set<string>> = {
				parent: new Set(),
				child: new Set(),
				supportive_sibling: new Set(),
				challenging_sibling: new Set(),
			};

			// For each role, dynamic links come from other notes' INVERSE_ROLE
			// blocks: my parent section is populated by notes that have me in
			// their child block, etc. Siblings are mirrored, so they pull from
			// the same role tag in the other note.
			await Promise.all(
				sections.map(async ({ role }) => {
					const otherTag = tagFor(settings, INVERSE_ROLE[role]);
					const dynamicLinks = await this.fetchDynamicLinks(otherTag, activeFile.name);
					dynamicLinks.forEach((link) => directionLinks[role].add(link));
				})
			);

			sections.forEach(({ role, tag, label }) => {
				const section = container.createEl("div", { cls: "compass-section" });
				section.createEl("h6", { text: label });

				const hardcodedLinks = this.extractHardcodedLinks(tag, content);
				hardcodedLinks.forEach((link) => directionLinks[role].add(link));

				const allLinks = Array.from(directionLinks[role]);
				if (allLinks.length > 0) {
					allLinks.forEach((link) => {
						const linkEl = section.createEl("p");
						linkEl.createEl("a", {
							text: link,
							href: `obsidian://open?vault=${this.app.vault.getName()}&file=${encodeURIComponent(
								link
							)}`,
						});
					});
				} else {
					section.createEl("p", { text: "..." });
				}
			});

			console.log("Compass View rendered successfully.");
		} catch (error) {
			console.error("Error rendering CompassView:", error);
		}
	}

	private extractHardcodedLinks(blockTag: string, content: string): string[] {
		const regex = new RegExp("```" + escapeRegExpStr(blockTag) + "\\n([\\s\\S]*?)```", "gm");
		const matches = Array.from(content.matchAll(regex));
		const links: string[] = [];
		for (const match of matches) {
			const sectionContent = match[1];
			const linkRegex = /\[\[(.*?)\]\]/g;
			const sectionLinks = Array.from(sectionContent.matchAll(linkRegex), (m) => m[1]);
			links.push(...sectionLinks);
		}
		return links;
	}

	private async fetchDynamicLinks(blockTag: string, currentFile: string): Promise<string[]> {
		try {
			const dv = this.app.plugins.getPlugin("dataview");
			if (!dv) throw new Error("Dataview plugin is not enabled or not available.");

			const allNotes = dv.api.pages();
			const result = new Set<string>();
			const tagEsc = escapeRegExpStr(blockTag);
			const fileEsc = escapeRegExpStr(currentFile);

			for (const note of allNotes) {
				const content = (await dv.api.io.load(note.file.path)) || "";
				const regex = new RegExp(
					"```" + tagEsc + "[\\s\\S]*?\\[\\[" + fileEsc + "\\]\\][\\s\\S]*?```",
					"gm"
				);
				const matches = content.match(regex);
				if (matches) {
					result.add(note.file.name);
				}
			}

			return Array.from(result).sort();
		} catch (error) {
			console.error("Error fetching dynamic links:", error);
			return [];
		}
	}
}

/*──────────────────────────────────────────────
   2) NavigationView
──────────────────────────────────────────────*/
export class NavigationView extends ItemView {
	static VIEW_TYPE = "navigation-view";
	plugin: FourWindsPlugin;
	cy: cytoscape.Core | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: FourWindsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return NavigationView.VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Navigation View";
	}

	getIcon(): string {
		return "compass";
	}

	async onOpen() {
		this.registerEvent(this.app.workspace.on("file-open", () => this.render()));
		await this.render();
	}

	async onClose() {
		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}
	}

	escapeRegExp(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	// Normalize an interior wikilink target to its bare basename:
	// strip alias (`|...`), heading (`#...`), path prefix, and `.md` suffix.
	linkToBasename(raw: string): string {
		let s = raw.trim();
		const pipe = s.indexOf("|");
		if (pipe !== -1) s = s.slice(0, pipe);
		const hash = s.indexOf("#");
		if (hash !== -1) s = s.slice(0, hash);
		s = s.replace(/\.md$/i, "");
		const slash = s.lastIndexOf("/");
		if (slash !== -1) s = s.slice(slash + 1);
		return s.trim();
	}

	getOppositeDirection(dir: string): string {
		switch (dir.toLowerCase()) {
			case "north": return "south";
			case "south": return "north";
			case "east": return "west";
			case "west": return "east";
			default: return dir;
		}
	}

	// Mutual = both notes declare the relationship. For siblings (which mirror)
	// that's the same role on both sides; for parent/child it's the inverse.
	// Returns true iff `otherName`'s INVERSE_ROLE[myRole] block contains a link
	// back to `myName`. Path-prefixed and aliased / heading-suffixed links match.
	async checkMutualConnection(
		myName: string,
		otherName: string,
		myRole: Role
	): Promise<boolean> {
		try {
			const otherFile = this.app.metadataCache.getFirstLinkpathDest(otherName, "");
			if (!otherFile) return false;

			const otherContent = await this.app.vault.cachedRead(otherFile);
			const inverseRole = INVERSE_ROLE[myRole];
			const tag = tagFor(this.plugin.settings, inverseRole);

			const blockRegex = new RegExp("```" + this.escapeRegExp(tag) + "\\n([\\s\\S]*?)```", "gi");
			const cleanMy = myName.replace(/\.md$/i, "");
			const escapedName = this.escapeRegExp(cleanMy);
			const linkRegex = new RegExp(
				"\\[\\[(?:[^\\]\\n#|]*\\/)?(" + escapedName + ")(?:\\.md)?(?:[#|][^\\]\\n]*)?\\]\\]",
				"i"
			);

			let m: RegExpExecArray | null;
			while ((m = blockRegex.exec(otherContent)) !== null) {
				if (linkRegex.test(m[1])) return true;
			}
			return false;
		} catch (error) {
			console.error("Error checking mutual connection:", error);
			return false;
		}
	}

	async render() {
		const container = this.contentEl;
		container.empty();

		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}

		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			container.createEl("p", { text: "No active note selected." });
			return;
		}

		const cyContainer = container.createDiv({ cls: "navigation-cy-container" });
		cyContainer.style.width = "100%";
		cyContainer.style.height = "100%";

		const fileName = activeFile.name.replace(/\.md$/i, "");
		const width = cyContainer.clientWidth || 600;
		const height = cyContainer.clientHeight || 400;
		const centerX = width / 2;
		const centerY = height / 2;

		const nodes: cytoscape.ElementDefinition[] = [];
		const edges: cytoscape.ElementDefinition[] = [];

		nodes.push({
			data: { id: "central", label: fileName, type: "central" },
			position: { x: centerX, y: centerY },
		});

		const content = await this.app.vault.cachedRead(activeFile);
		if (!content) {
			container.createEl("p", { text: "This note is empty or unreadable." });
			return;
		}

		const settings = this.plugin.settings;
		const centerNameLC = fileName.toLowerCase();
		// Lowercased basename → primary branch info. Used both to dedupe a
		// note appearing under multiple roles AND to draw cross-branch edges
		// instead of duplicate secondary nodes when one branch references
		// another that's already on the graph.
		const branchByName = new Map<string, { nodeId: string; role: Role; layoutDir: string }>();

		for (const role of ROLES) {
			const tag = tagFor(settings, role);
			const layoutDir = ROLE_TO_LAYOUT_DIR[role];
			const dirRegex = new RegExp("```" + this.escapeRegExp(tag) + "\\n([\\s\\S]*?)```", "gm");
			const matches = Array.from(content.matchAll(dirRegex));
			if (!matches.length) continue;

			const linkSet = new Set<string>();
			for (const m of matches) {
				const blockContent = m[1];
				const linkRegex = /\[\[(.*?)\]\]/g;
				let linkMatch: RegExpExecArray | null;
				while ((linkMatch = linkRegex.exec(blockContent)) !== null) {
					const basename = this.linkToBasename(linkMatch[1]);
					if (!basename) continue;
					if (basename.toLowerCase() === centerNameLC) continue;
					linkSet.add(basename);
				}
			}

			if (!linkSet.size) continue;

			const uniqueLinks = Array.from(linkSet);
			const positions = calculateNodePositions(
				layoutDir,
				uniqueLinks.length,
				centerX,
				centerY,
				width,
				height,
				uniqueLinks
			);

			uniqueLinks.forEach((link, i) => {
				const linkLC = link.toLowerCase();
				// Already added under another role — skip duplicate primary node
				if (branchByName.has(linkLC)) return;

				const nodeId = `${role}_${i}`;
				branchByName.set(linkLC, { nodeId, role, layoutDir });

				nodes.push({
					data: {
						id: nodeId,
						label: link,
						type: "branch",
						direction: layoutDir,
						role: role,
						fileName: link,
					},
					position: positions[i],
				});

				edges.push({
					data: {
						id: `edge_${nodeId}`,
						source: "central",
						target: nodeId,
						isMutual: false,
					},
				});
			});
		}

		// Mutuality check for every primary branch: if the other note has me
		// in its INVERSE_ROLE[myRole] block, the central→branch edge becomes
		// bi-directional. Works for all four roles (parent↔child asymmetric,
		// siblings symmetric mirror).
		const mutualEdges = new Set<string>();
		for (const [linkLC, { nodeId, role }] of branchByName.entries()) {
			const isMutual = await this.checkMutualConnection(fileName, linkLC, role);
			if (isMutual) mutualEdges.add(`edge_${nodeId}`);
		}

		for (const edge of edges) {
			const edgeId = edge.data.id as string;
			edge.data.isMutual = mutualEdges.has(edgeId);
		}

		this.cy = cytoscapeFn({
			container: cyContainer,
			elements: [...nodes, ...edges],
			style: [
				// Shared compass styling (wrapped labels, central node, the
				// four direction-colored branch selectors, base edges) plus
				// this view's extras below.
				...baseGraphStyles({ centralSize: 30, branchSize: 15, centralFont: 14, branchFont: 12 }),
				{
					selector: 'node[type="secondary"]',
					style: {
						"background-color": "#999999",
						width: "10px",
						height: "10px",
						label: "data(label)",
						"text-valign": "bottom",
						"text-halign": "center",
						"text-margin-y": 7,
						"font-size": "10px",
						color: "#fff",
						opacity: 0.2,
					},
				},
				{
					selector: 'node[type="tertiary"]',
					style: {
						"background-color": "#666666",
						width: "8px",
						height: "8px",
						label: "data(label)",
						"text-valign": "bottom",
						"text-halign": "center",
						"text-margin-y": 5,
						"font-size": "8px",
						color: "#fff",
						opacity: 0,
						visibility: "hidden",
					},
				},
				{
					selector: 'edge[?isMutual]',
					style: {
						"source-arrow-shape": "triangle",
						"source-arrow-color": "#917959",
						opacity: 0.7,
					},
				},
				{
					selector: 'edge[?isCross]',
					style: {
						"line-color": "#9c8262",
						opacity: 0.5,
					},
				},
			],
			layout: { name: "preset" },
			userPanningEnabled: true,
			userZoomingEnabled: true,
			boxSelectionEnabled: false,
			wheelSensitivity: 0.3,
		});

		if (this.cy) {
			this.cy.nodes().grabify();
		}

		// Suppress the browser's native context menu inside the graph so our
		// own menu is the only one that appears on right-click.
		cyContainer.addEventListener("contextmenu", (e) => e.preventDefault());

		if (this.cy) {
			this.cy.on("tap", "node", (evt) => {
				const node = evt.target;
				const data = node.data();
				const linkName = data.type === "central"
					? activeFile.name
					: (data.fileName || data.label || "");
				if (!linkName) return;

				// Shift+click opens in a vertical split to the right of the
				// current note; plain click reuses the active leaf.
				const original = evt.originalEvent as MouseEvent | undefined;
				if (original?.shiftKey) {
					this.app.workspace.openLinkText(linkName, "", "split");
				} else {
					this.app.workspace.openLinkText(linkName, "");
				}
			});

			// Right-click anywhere in the graph opens a small action menu.
			// On a node, it leads with open-in-new-tab / open-in-split for
			// that note; on the background it's just the graph actions.
			this.cy.on("cxttap", (evt) => {
				const original = evt.originalEvent as MouseEvent | undefined;
				if (original) original.preventDefault?.();
				const menu = new Menu();
				const target = evt.target;
				if (target && target !== this.cy && typeof target.isNode === "function" && target.isNode()) {
					const data = target.data();
					const linkName = data.type === "central"
						? activeFile.name
						: (data.fileName || data.label || "");
					if (linkName) {
						menu.addItem((item) =>
							item.setTitle("Open in new tab")
								.setIcon("file-plus")
								.onClick(() => this.app.workspace.openLinkText(linkName, "", "tab"))
						);
						menu.addItem((item) =>
							item.setTitle("Open to the right")
								.setIcon("separator-vertical")
								.onClick(() => this.app.workspace.openLinkText(linkName, "", "split"))
						);
						menu.addSeparator();
					}
				}
				menu.addItem((item) =>
					item.setTitle("Refresh")
						.setIcon("refresh-cw")
						.onClick(() => this.render())
				);
				menu.addItem((item) =>
					item.setTitle("Auto-link compass")
						.setIcon("link")
						.onClick(() => this.plugin.runAutoLinkCompass())
				);
				menu.addSeparator();
				menu.addItem((item) =>
					item.setTitle("Navigate back")
						.setIcon("arrow-left")
						.onClick(() => this.navigateInMostRecentMarkdownLeaf("back"))
				);
				menu.addItem((item) =>
					item.setTitle("Navigate forward")
						.setIcon("arrow-right")
						.onClick(() => this.navigateInMostRecentMarkdownLeaf("forward"))
				);
				if (original) menu.showAtMouseEvent(original);
			});

			this.cy.on("mouseover", "node", (evt) => {
				if (!this.cy) return;
				const node = evt.target;
				const nodeData = node.data();

				this.cy.elements().style("opacity", 0.2);
				node.style("opacity", 1);
				node.connectedEdges().style("opacity", 0.8);
				node.neighborhood().style("opacity", 1);

				if (nodeData.type === "secondary") {
					this.cy.nodes('[type="tertiary"]')
						.style("visibility", "hidden")
						.style("opacity", 0);
					this.loadTertiaryNodes(node);
				}
			});

			this.cy.on("mouseout", "node", (evt) => {
				if (!this.cy) return;
				const node = evt.target;
				const nodeData = node.data();

				this.cy.nodes().forEach((n) => {
					const nData = n.data();
					if (nData.type === "secondary") {
						n.style("opacity", 0.2);
					} else if (nData.type === "tertiary") {
						if (nodeData.type !== "secondary" || nodeData.id !== nData.parentId) {
							n.style("visibility", "hidden").style("opacity", 0);
						}
					} else {
						n.style("opacity", 1);
					}
				});
				this.cy.edges().style("opacity", 0.7);
				this.cy.edges('[?isMutual]').style("opacity", 0.8);
			});
		}

		if (this.cy) {
			const branchNodes = Array.from(this.cy.nodes('[type="branch"]'));
			for (const branchNode of branchNodes) {
				await this.processBranchNode(branchNode, branchByName);
			}
		}

		// Per-branch placement can't see other branches' secondaries — clusters
		// from adjacent branches land on top of each other. Resolve globally:
		// secondaries move, central + primaries stay anchored.
		if (this.cy) {
			resolveLabelOverlaps(
				this.cy.nodes('[type="secondary"]'),
				this.cy.nodes('[type="central"], [type="branch"]')
			);
		}

		// Positions are unclamped, so a busy compass extends past the pane.
		// Fit the camera to everything visible (tertiaries stay hidden until
		// hover) — spread out beats overlapping, and pan/zoom remain live.
		if (this.cy) {
			const visible = this.cy.elements().filter((el) => el.data("type") !== "tertiary");
			if (visible.length > 1) this.cy.fit(visible, 30);
		}
	}

	// For each primary branch B, look at B's same-role admonition block and
	// either (a) draw a cross-branch edge to an existing primary node when the
	// link target is already on the graph, or (b) add a secondary node
	// otherwise. Cross-edges are marked mutual when both branches reference
	// each other along the appropriate inverse role. This is what stops the
	// same note from showing up multiple times as a node.
	// Right-click "Navigate back/forward" can't just fire app:go-back —
	// when invoked from the Navigation View pane, *we* are the active leaf
	// and have no history of our own. Find the most recently active markdown
	// leaf, focus it, then call its history API directly.
	private navigateInMostRecentMarkdownLeaf(direction: "back" | "forward"): void {
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		let target: WorkspaceLeaf | null = null;
		let bestTime = -1;
		for (const leaf of leaves) {
			const t = (leaf as any).activeTime || 0;
			if (t > bestTime) {
				bestTime = t;
				target = leaf;
			}
		}
		if (!target) {
			new Notice("No recent note to navigate");
			return;
		}
		this.app.workspace.setActiveLeaf(target, { focus: true });
		const hist = (target as any).history;
		if (!hist) return;
		if (direction === "back" && typeof hist.back === "function") hist.back();
		else if (direction === "forward" && typeof hist.forward === "function") hist.forward();
	}

	async processBranchNode(
		branchNode: cytoscape.NodeSingular,
		branchByName: Map<string, { nodeId: string; role: Role; layoutDir: string }>
	): Promise<void> {
		if (!this.cy) return;

		const data = branchNode.data();
		const role = data.role as Role;
		const layoutDir = data.direction as string;
		const branchNoteName = (data.fileName as string) ?? (data.label as string);

		if (!branchNoteName || !role) return;

		const file = this.app.metadataCache.getFirstLinkpathDest(branchNoteName, "");
		if (!file) return;

		try {
			const content = await this.app.vault.cachedRead(file);
			const tag = tagFor(this.plugin.settings, role);
			const dirRegex = new RegExp("```" + this.escapeRegExp(tag) + "\\n([\\s\\S]*?)```", "gm");

			// Skip the central note when found in a branch's compass — that
			// relationship is already represented by the central→branch edge
			// (and its mutuality flag). Adding a "secondary" pointing at the
			// central name would just duplicate the central node visually.
			const centralLabel = (this.cy.getElementById("central").data("label") as string) || "";
			const centralLC = centralLabel.toLowerCase();

			const collectedLinks = new Set<string>();
			let m: RegExpExecArray | null;
			while ((m = dirRegex.exec(content)) !== null) {
				const linkRegex = /\[\[(.*?)\]\]/g;
				let linkMatch: RegExpExecArray | null;
				while ((linkMatch = linkRegex.exec(m[1])) !== null) {
					const basename = this.linkToBasename(linkMatch[1]);
					if (!basename) continue;
					const lc = basename.toLowerCase();
					if (lc === branchNoteName.toLowerCase()) continue;
					if (lc === centralLC) continue;
					collectedLinks.add(basename);
				}
			}

			if (!collectedLinks.size) return;

			// Build a label→nodeId map of everything already on the graph
			// (primaries + secondaries added by previously-processed branches)
			// so this branch's secondaries can dedupe via cross-edges instead
			// of creating duplicate nodes.
			const existingByLabel = new Map<string, { nodeId: string; nodeType: string; role?: Role }>();
			this.cy.nodes().forEach((n) => {
				const nLabel = (n.data("label") as string) || "";
				const nType = (n.data("type") as string) || "";
				if (!nLabel || nType === "central" || nType === "tertiary") return;
				existingByLabel.set(nLabel.toLowerCase(), {
					nodeId: n.id() as string,
					nodeType: nType,
					role: n.data("role") as Role | undefined,
				});
			});

			// Split: targets that already exist on the graph → cross-edges.
			// Everything else → real new secondary nodes.
			const trueSecondaries: string[] = [];
			const crossTargets: Array<{ targetId: string; targetRole?: Role }> = [];
			for (const link of collectedLinks) {
				const existing = existingByLabel.get(link.toLowerCase());
				if (existing && existing.nodeId !== data.id) {
					crossTargets.push({ targetId: existing.nodeId, targetRole: existing.role });
				} else {
					trueSecondaries.push(link);
				}
			}

			// Cross-branch edges. If we already have an edge in the reverse
			// direction (the other branch was processed first and pointed at
			// us), upgrade it to mutual. Otherwise add a fresh edge.
			for (const { targetId, targetRole } of crossTargets) {
				const fwdId = `cross_${data.id}__${targetId}`;
				const revId = `cross_${targetId}__${data.id}`;
				if (this.cy.getElementById(fwdId).length > 0) continue;
				const reverse = this.cy.getElementById(revId);
				if (reverse.length > 0) {
					// Mutual when this direction is the inverse of how the
					// other branch reached us. Roles are compatible iff
					// INVERSE_ROLE[myRole] === targetRole (parent/child) or
					// myRole === targetRole (sibling mirror).
					const compatible = !!targetRole &&
						(targetRole === INVERSE_ROLE[role] || targetRole === role);
					if (compatible) reverse.data("isMutual", true);
					continue;
				}
				this.cy.add({
					group: "edges",
					data: {
						id: fwdId,
						source: data.id,
						target: targetId,
						isMutual: false,
						isCross: true,
					},
				});
			}

			if (!trueSecondaries.length) return;

			const branchPos = branchNode.position();
			const scale = 0.6;
			const posArray = calculateNodePositions(
				layoutDir,
				trueSecondaries.length,
				branchPos.x,
				branchPos.y,
				this.cy.width() * scale,
				this.cy.height() * scale,
				trueSecondaries
			);

			const addedSecondary = new Set<string>();
			trueSecondaries.forEach((sec, i) => {
				const secLC = sec.toLowerCase();
				if (addedSecondary.has(secLC)) return;
				addedSecondary.add(secLC);

				const secNodeId = data.id + "_sec_" + i;
				this.cy?.add({
					group: "nodes",
					data: {
						id: secNodeId,
						label: sec,
						fileName: sec,
						type: "secondary",
						parentId: data.id,
						direction: layoutDir,
						role: role,
					},
					position: posArray[i],
				});
				this.cy?.add({
					group: "edges",
					data: {
						id: secNodeId + "_edge",
						source: data.id,
						target: secNodeId,
					},
				});
			});
		} catch (error) {
			console.error("Error processing branch node:", error);
		}
	}

	async loadTertiaryNodes(secondaryNode: cytoscape.NodeSingular): Promise<void> {
		if (!this.cy) return;

		const data = secondaryNode.data();
		const parentData = this.cy.getElementById(data.parentId as string).data();
		const role = (parentData.role as Role) || (data.role as Role);
		const layoutDir = parentData.direction as string;
		const noteName = data.fileName as string || data.label as string;

		if (!noteName || !role || !layoutDir) return;

		const existingTertiary = this.cy.nodes(`[parentId="${data.id}"]`);
		if (existingTertiary.length > 0) {
			existingTertiary.style("visibility", "visible").style("opacity", 0.7);
			return;
		}

		const file = this.app.metadataCache.getFirstLinkpathDest(noteName, "");
		if (!file) return;

		try {
			const content = await this.app.vault.cachedRead(file);
			const tag = tagFor(this.plugin.settings, role);
			const dirRegex = new RegExp("```" + this.escapeRegExp(tag) + "\\n([\\s\\S]*?)```", "gm");
			const match = dirRegex.exec(content);
			if (!match) return;

			const blockContent = match[1];
			const linkRegex = /\[\[(.*?)\]\]/g;
			const tertiaryLinks: string[] = [];

			const centralLabel = this.cy.getElementById("central").data("label") as string;
			const centralLC = centralLabel.toLowerCase();

			let linkMatch: RegExpExecArray | null;
			while ((linkMatch = linkRegex.exec(blockContent)) !== null) {
				const tLink = this.linkToBasename(linkMatch[1]);
				if (!tLink) continue;

				const tLinkLC = tLink.toLowerCase();
				if (tLinkLC === centralLC) continue;

				const alreadyInGraph = this.cy.nodes().some(n => {
					const nodeLabel = n.data("label") as string;
					return !!nodeLabel && nodeLabel.toLowerCase() === tLinkLC &&
						   n.data("type") !== "tertiary";
				});

				if (!alreadyInGraph) {
					tertiaryLinks.push(tLink);
				}
			}

			if (!tertiaryLinks.length) return;

			const addedTertiary = new Set<string>();

			const secPos = secondaryNode.position();
			const scale = 0.4;
			const oppDir = this.getOppositeDirection(layoutDir);
			const posArray = calculateNodePositions(
				oppDir,
				tertiaryLinks.length,
				secPos.x,
				secPos.y,
				this.cy.width() * scale,
				this.cy.height() * scale
			);

			const addedIds: string[] = [];
			tertiaryLinks.forEach((tLink, i) => {
				const tLinkLC = tLink.toLowerCase();
				if (addedTertiary.has(tLinkLC)) return;
				addedTertiary.add(tLinkLC);

				const tId = data.id + "_tertiary_" + i;
				addedIds.push(tId);
				this.cy?.add({
					group: "nodes",
					data: {
						id: tId,
						label: tLink,
						fileName: tLink,
						type: "tertiary",
						parentId: data.id,
					},
					position: posArray[i],
					style: {
						visibility: "visible",
						opacity: 0.7,
					},
				});
				this.cy?.add({
					group: "edges",
					data: {
						id: tId + "_edge",
						source: data.id,
						target: tId,
					},
					style: {
						opacity: 0.5,
						"line-color": "#aaaaaa",
						width: "1px",
					},
				});
			});

			// Tertiaries are placed around the hovered secondary with no
			// knowledge of the rest of the graph — push them off everything
			// already visible (and each other) before they appear.
			if (addedIds.length && this.cy) {
				let added = this.cy.collection();
				for (const id of addedIds) added = added.union(this.cy.getElementById(id));
				const fixed = this.cy.nodes('[type="central"], [type="branch"], [type="secondary"]');
				resolveLabelOverlaps(added.nodes(), fixed);
			}
		} catch (error) {
			console.error("Error loading tertiary nodes:", error);
		}
	}
}

/*──────────────────────────────────────────────
   3) Settings Tab
──────────────────────────────────────────────*/
class FourWindsSettingTab extends PluginSettingTab {
	plugin: FourWindsPlugin;

	constructor(app: any, plugin: FourWindsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Four Winds Settings" });

		/* ── README link ── */
		const helpBox = containerEl.createDiv();
		helpBox.style.cssText = "display: flex; align-items: center; gap: 12px; padding: 10px 14px; margin: 0 0 16px 0; background: var(--background-secondary); border-left: 3px solid var(--interactive-accent); border-radius: 4px;";
		const helpText = helpBox.createDiv();
		helpText.style.cssText = "flex: 1; color: var(--text-muted); font-size: 0.9em; line-height: 1.4;";
		helpText.setText("New to Four Winds? The README walks through the compass model, fleeting-note flow, and discovery features.");
		const helpBtn = helpBox.createEl("button", { text: "📖 Open README" });
		helpBtn.style.cssText = "flex-shrink: 0; background: var(--interactive-accent); color: var(--text-on-accent, #fff); border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-weight: 500;";
		helpBtn.addEventListener("click", () => {
			window.open("https://github.com/PoweredbyPugs/four-winds/blob/main/README.md", "_blank");
		});

		/* ── Compass ── */
		containerEl.createEl("h3", { text: "Compass" });

		const compassIntro = containerEl.createEl("p");
		compassIntro.style.cssText = "color: var(--text-muted); font-size: 0.9em; max-width: 60ch; margin-top: 0;";
		compassIntro.setText("Each role's name is used as the admonition tag suffix (ad-{name}) and as the heading shown in the compass view. Renaming a role here changes both at once.");

		const compassFields: Array<{ label: string; desc: string; role: Role }> = [
			{ label: "Parent", desc: "Notes that this note descends from", role: "parent" },
			{ label: "Supportive sibling", desc: "Peers that reinforce or align with this note", role: "supportive_sibling" },
			{ label: "Child", desc: "Notes that descend from this note", role: "child" },
			{ label: "Challenging sibling", desc: "Peers that contrast with or challenge this note", role: "challenging_sibling" },
		];

		compassFields.forEach(({ label, desc, role }) => {
			new Setting(containerEl)
				.setName(label)
				.setDesc(desc)
				.addText((text) =>
					text
						.setPlaceholder(DEFAULT_DIRECTION_NAMES[role])
						.setValue(this.plugin.settings.directionNames[role])
						.onChange(async (val) => {
							this.plugin.settings.directionNames[role] =
								(val || "").trim() || DEFAULT_DIRECTION_NAMES[role];
							await this.plugin.saveSettings();
						})
				);
		});

		/* ── Fleeting notes ── */
		containerEl.createEl("h3", { text: "Fleeting notes" });
		const fleetingIntro = containerEl.createEl("p");
		fleetingIntro.style.cssText = "color: var(--text-muted); font-size: 0.9em; max-width: 60ch; margin-top: 0;";
		fleetingIntro.setText("Where Four Winds looks for raw, unprocessed notes that need to be developed and linked into the compass. The Process Seeds modal cycles through these.");

		this.renderDirectoryList(containerEl, "seedDirectories", "Folder");

		// Tags
		this.renderTagList(containerEl);

		// Default sort
		new Setting(containerEl)
			.setName("Sort mode")
			.setDesc("How fleeting notes are ordered when the Process Seeds modal opens")
			.addDropdown((dd) => {
				dd.addOption("shuffle", "Shuffle");
				dd.addOption("cday", "Created (oldest first)");
				dd.addOption("mday", "Modified (newest first)");
				dd.addOption("tag", "By tag");
				dd.setValue(this.plugin.settings.seedSortMode);
				dd.onChange(async (val) => {
					this.plugin.settings.seedSortMode = val as SeedSortMode;
					await this.plugin.saveSettings();
				});
			});

		// Metadata field name
		new Setting(containerEl)
			.setName("Metadata field")
			.setDesc("Inline field name where each fleeting note's capture text lives (e.g. seed:: my idea)")
			.addText((text) =>
				text
					.setPlaceholder("seed")
					.setValue(this.plugin.settings.seedField)
					.onChange(async (val) => {
						this.plugin.settings.seedField = val || "seed";
						await this.plugin.saveSettings();
					})
			);

		/* ── Processing ── */
		containerEl.createEl("h3", { text: "Processing" });

		this.renderTemplateList(containerEl);

		/* ── Discovery ── */
		containerEl.createEl("h3", { text: "Discovery" });
		this.renderDirectoryList(containerEl, "discoveryDirectories", "Discovery folder");

		new Setting(containerEl)
			.setName("Auto-link")
			.setDesc("When linking via Discovery, also add the reverse link in the discovered note")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoLink)
					.onChange(async (val) => {
						this.plugin.settings.autoLink = val;
						await this.plugin.saveSettings();
					})
			);

		// Keyboard direction bindings for the Discovery modal. O/D/F/Z stay
		// baked in; only the four role-swipe equivalents are user-rebindable.
		containerEl.createEl("h4", { text: "Discovery direction keys" });
		const keyHint = containerEl.createEl("p");
		keyHint.style.cssText = "color: var(--text-muted); font-size: 0.85em; margin: 0 0 8px;";
		keyHint.setText("Click 'Rebind' on a row and press the key you want to use. Any single key works — arrows, letters, etc.");
		for (const role of ROLES) {
			const setting = new Setting(containerEl).setName(`${ROLE_LABELS[role]} key`);
			const currentKey = () => this.plugin.settings.discoveryKeys[role] || DEFAULT_DISCOVERY_KEYS[role];
			const formatKey = (k: string) => {
				const map: Record<string, string> = { arrowup: "↑ Up arrow", arrowright: "→ Right arrow", arrowdown: "↓ Down arrow", arrowleft: "← Left arrow" };
				return map[k.toLowerCase()] || k.toUpperCase();
			};
			setting.setDesc(`Bound to: ${formatKey(currentKey())}`);
			setting.addButton((btn) => {
				btn.setButtonText("Rebind").onClick(() => {
					btn.setButtonText("Press a key…");
					const capture = (e: KeyboardEvent) => {
						e.preventDefault();
						e.stopPropagation();
						document.removeEventListener("keydown", capture, true);
						const captured = (e.key || "").toLowerCase();
						if (!captured) {
							btn.setButtonText("Rebind");
							return;
						}
						this.plugin.settings.discoveryKeys[role] = captured;
						this.plugin.saveSettings().then(() => this.display());
					};
					document.addEventListener("keydown", capture, true);
				});
			});
			setting.addExtraButton((btn) => {
				btn.setIcon("reset").setTooltip("Reset to default").onClick(async () => {
					this.plugin.settings.discoveryKeys[role] = DEFAULT_DISCOVERY_KEYS[role];
					await this.plugin.saveSettings();
					this.display();
				});
			});
		}

		/* ── Stella ── */
		containerEl.createEl("h3", { text: "Stella Integration" });

		new Setting(containerEl)
			.setName("Load context on process")
			.setDesc("When processing a seed, open Stella and load the note into context")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.stellaOnProcess)
					.onChange(async (val) => {
						this.plugin.settings.stellaOnProcess = val;
						await this.plugin.saveSettings();
					})
			);

		/* ── Verify ── */
		containerEl.createEl("h3", { text: "Verify" });

		const verifyContainer = containerEl.createDiv({ cls: "four-winds-verify" });
		const verifyBtn = new Setting(verifyContainer)
			.setName("Verify configuration")
			.setDesc("Check that folders, template, capture format, and integrations are valid")
			.addButton((btn) =>
				btn.setButtonText("Verify").setCta().onClick(() => {
					this.runVerify(verifyContainer);
				})
			);
	}

	private runVerify(container: HTMLElement) {
		// Remove previous results
		const prev = container.querySelector(".four-winds-verify-results");
		if (prev) prev.remove();

		const results = container.createDiv({ cls: "four-winds-verify-results" });
		const s = this.plugin.settings;
		let allGood = true;

		const check = (label: string, pass: boolean, detail: string) => {
			const row = results.createDiv({ cls: `four-winds-verify-row ${pass ? "pass" : "fail"}` });
			row.createEl("span", { cls: "four-winds-verify-icon", text: pass ? "✓" : "✗" });
			row.createEl("span", { cls: "four-winds-verify-label", text: label });
			row.createEl("span", { cls: "four-winds-verify-detail", text: detail });
			if (!pass) allGood = false;
		};

		// Check fleeting-note folders
		for (const dir of s.seedDirectories) {
			if (!dir) {
				check("Fleeting notes folder", false, "Empty folder path");
				continue;
			}
			const folder = this.app.vault.getAbstractFileByPath(dir);
			check(`Fleeting notes folder: ${dir}`, folder instanceof TFolder, folder ? "Found" : "Not found");
		}
		if (s.seedDirectories.length === 0) {
			check("Fleeting notes folder", false, "No folders configured");
		}

		// Check discovery directories
		for (const dir of s.discoveryDirectories) {
			if (!dir) {
				check("Discovery folder", false, "Empty folder path");
				continue;
			}
			const folder = this.app.vault.getAbstractFileByPath(dir);
			check(`Discovery folder: ${dir}`, folder instanceof TFolder, folder ? "Found" : "Not found");
		}

		// Check templates
		const validTemplates = s.templates.filter((t) => t.path);
		if (validTemplates.length === 0) {
			check("Templates", false, "No templates configured");
		}
		for (const tmpl of validTemplates) {
			const tFile = this.app.vault.getAbstractFileByPath(tmpl.path);
			check(`Template: ${tmpl.path}`, tFile instanceof TFile, tFile ? "Found" : "Not found");

			if (tFile instanceof TFile) {
				this.app.vault.cachedRead(tFile).then((content: string) => {
					const hasPlaceholder = content.contains("{{capture}}");
					const hasHeading = tmpl.captureHeading
						? new RegExp(`^#{1,6}\\s+${escapeRegExpStr(tmpl.captureHeading)}`, "m").test(content)
						: false;
					check(`Template content: ${tmpl.path}`, hasPlaceholder || hasHeading,
						hasPlaceholder ? "{{capture}} found" : hasHeading ? `Heading "${tmpl.captureHeading}" found` : "No {{capture}} or matching heading");
				});
			}

			const hasVars = /\{(title|date|time|capture)\}/.test(tmpl.captureFormat);
			check(`Capture format: ${tmpl.path}`, hasVars && tmpl.captureFormat.length > 0,
				hasVars ? "Valid" : "No variables found");

			if (tmpl.destinationFolder) {
				const destFolder = this.app.vault.getAbstractFileByPath(tmpl.destinationFolder);
				check(`Destination: ${tmpl.destinationFolder}`, destFolder instanceof TFolder,
					destFolder ? "Found" : "Not found");
			}
		}

		// Check metadata field
		check("Metadata field", s.seedField.length > 0, s.seedField ? `"${s.seedField}::"` : "Empty");

		// Check Stella
		if (s.stellaOnProcess) {
			const stella = this.app.plugins.getPlugin("Stella-dev") || this.app.plugins.getPlugin("stella");
			check("Stella plugin", !!stella, stella ? "Installed and enabled" : "Not found — disable toggle or install Stella");
		}

		// Summary
		const summary = results.createDiv({ cls: `four-winds-verify-summary ${allGood ? "pass" : "fail"}` });
		summary.setText(allGood ? "All checks passed" : "Some checks failed — review above");
	}

	private getAllFolders(): string[] {
		const folders: string[] = [];
		const recurse = (folder: TFolder) => {
			folders.push(folder.path);
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					recurse(child);
				}
			}
		};
		recurse(this.app.vault.getRoot());
		return folders.filter((f) => f !== "/").sort();
	}

	private renderDirectoryList(
		containerEl: HTMLElement,
		key: "seedDirectories" | "discoveryDirectories",
		label: string
	) {
		const dirs = this.plugin.settings[key];
		const allFolders = this.getAllFolders();

		for (let i = 0; i < dirs.length; i++) {
			new Setting(containerEl)
				.setName(`${label} ${i + 1}`)
				.addDropdown((dropdown) => {
					dropdown.addOption("", "— Select folder —");
					for (const folder of allFolders) {
						dropdown.addOption(folder, folder);
					}
					dropdown.setValue(dirs[i]);
					dropdown.onChange(async (val) => {
						dirs[i] = val;
						await this.plugin.saveSettings();
					});
				})
				.addButton((btn) =>
					btn.setButtonText("Remove").onClick(async () => {
						dirs.splice(i, 1);
						await this.plugin.saveSettings();
						this.display();
					})
				);
		}

		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("Add folder").onClick(async () => {
				dirs.push("");
				await this.plugin.saveSettings();
				this.display();
			})
		);
	}

	private renderTemplateList(containerEl: HTMLElement) {
		const templates = this.plugin.settings.templates;
		const allFolders = this.getAllFolders();

		for (let i = 0; i < templates.length; i++) {
			const tmpl = templates[i];

			// Template group container
			const groupEl = containerEl.createDiv({ cls: "four-winds-template-group" });

			// Template path row
			new Setting(groupEl)
				.setName(`Template ${i + 1}`)
				.addText((text) => {
					text.setValue(tmpl.path).setDisabled(true);
					text.inputEl.style.cursor = "default";
				})
				.addButton((btn) =>
					btn.setButtonText("Browse").onClick(() => {
						const allFiles = this.app.vault.getMarkdownFiles();
						new FileSuggestModal(this.app, allFiles, async (file) => {
							tmpl.path = file.path;
							await this.plugin.saveSettings();
							this.display();
						}).open();
					})
				)
				.addButton((btn) =>
					btn.setButtonText("Remove").onClick(async () => {
						templates.splice(i, 1);
						await this.plugin.saveSettings();
						this.display();
					})
				);

			// Capture heading for this template
			new Setting(groupEl)
				.setName("Capture heading")
				.setDesc("Heading where capture is inserted")
				.addText((text) =>
					text
						.setPlaceholder("References")
						.setValue(tmpl.captureHeading)
						.onChange(async (val) => {
							tmpl.captureHeading = val;
							await this.plugin.saveSettings();
						})
				);

			// Capture format for this template (textarea)
			const formatSetting = new Setting(groupEl)
				.setName("Capture format")
				.setDesc("Variables: {title}, {date}, {time}, {capture}");
			const ta = new TextAreaComponent(formatSetting.controlEl);
			ta.setPlaceholder("- [[{title}]] — {date}\n{capture}")
				.setValue(tmpl.captureFormat);
			ta.inputEl.rows = 4;
			ta.inputEl.style.width = "100%";
			ta.inputEl.style.fontFamily = "monospace";
			ta.inputEl.style.fontSize = "13px";
			ta.onChange(async (val) => {
				tmpl.captureFormat = val;
				await this.plugin.saveSettings();
			});

			// Destination folder for this template
			new Setting(groupEl)
				.setName("Destination folder")
				.setDesc("Where the processed note is moved to")
				.addDropdown((dd) => {
					dd.addOption("", "— Same folder —");
					for (const folder of allFolders) {
						dd.addOption(folder, folder);
					}
					dd.setValue(tmpl.destinationFolder || "");
					dd.onChange(async (val) => {
						tmpl.destinationFolder = val;
						await this.plugin.saveSettings();
					});
				});
		}

		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("Add template").onClick(async () => {
				const allFiles = this.app.vault.getMarkdownFiles();
				new FileSuggestModal(this.app, allFiles, async (file) => {
					templates.push({
						path: file.path,
						captureHeading: "References",
						captureFormat: "- [[{title}]] — {date}",
						destinationFolder: "",
					});
					await this.plugin.saveSettings();
					this.display();
				}).open();
			})
		);
	}

	private renderTagList(containerEl: HTMLElement) {
		const tags = this.plugin.settings.seedTags;

		for (let i = 0; i < tags.length; i++) {
			new Setting(containerEl)
				.setName(`Tag ${i + 1}`)
				.addText((text) => {
					text.setValue(tags[i]).setDisabled(true);
					text.inputEl.style.cursor = "default";
				})
				.addButton((btn) =>
					btn.setButtonText("Change").onClick(() => {
						const allTags = getAllVaultTags(this.app).filter((t) => !tags.includes(t) || t === tags[i]);
						new TagSuggestModal(this.app, allTags, async (chosen) => {
							if (chosen) {
								tags[i] = chosen;
								await this.plugin.saveSettings();
								this.display();
							}
						}).open();
					})
				)
				.addButton((btn) =>
					btn.setButtonText("Remove").onClick(async () => {
						tags.splice(i, 1);
						await this.plugin.saveSettings();
						this.display();
					})
				);
		}

		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("Add tag").onClick(() => {
				const allTags = getAllVaultTags(this.app).filter((t) => !tags.includes(t));
				new TagSuggestModal(this.app, allTags, async (chosen) => {
					if (chosen && !tags.includes(chosen)) {
						tags.push(chosen);
						await this.plugin.saveSettings();
						this.display();
					}
				}).open();
			})
		);
	}
}

/*──────────────────────────────────────────────
   4) The Plugin Class
──────────────────────────────────────────────*/
export default class FourWindsPlugin extends Plugin {
	settings: FourWindsSettings;

	async onload() {
		console.log("Loading Four Winds...");

		await this.loadSettings();

		this.registerView(CompassView.VIEW_TYPE, (leaf) => new CompassView(leaf, this));
		this.registerView(NavigationView.VIEW_TYPE, (leaf) => new NavigationView(leaf, this));

		this.addCommand({
			id: "open-compass-view",
			name: "Open Compass View",
			callback: () => this.activateCompassView(),
		});

		this.addCommand({
			id: "open-navigation-view",
			name: "Open Navigation View",
			callback: () => this.activateNavigationView(),
		});

		this.addCommand({
			id: "process-seeds",
			name: "Process Seeds",
			callback: () => new SeedsModal(this.app, this).open(),
		});

		this.addCommand({
			id: "discover",
			name: "Discover",
			callback: () => new DiscoveryModal(this.app, this).open(),
		});

		this.addCommand({
			id: "auto-link-compass",
			name: "Auto-link compass",
			callback: () => this.runAutoLinkCompass(),
		});

		this.addSettingTab(new FourWindsSettingTab(this.app, this));

		// Compass links live inside admonition codeblocks, which Obsidian's
		// built-in "update internal links on rename" pass ignores. Track
		// renames ourselves and rewrite [[Old Name]] inside compass blocks
		// vault-wide.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile && file.extension === "md") {
					this.handleNoteRename(file, oldPath).catch((err) =>
						console.error("[Four Winds] rename sync failed:", err)
					);
				}
			})
		);

		this.activateCompassView();
	}

	// Rewrite [[oldBasename]] → [[newBasename]] inside every compass
	// admonition block in the vault. Only fires on true renames (basename
	// changed); folder moves keep the basename and wikilinks stay valid.
	// Alias / heading suffixes are preserved; path prefixes are dropped
	// because the new location may differ and bare basenames always resolve.
	async handleNoteRename(file: TFile, oldPath: string) {
		const oldName = oldPath.slice(oldPath.lastIndexOf("/") + 1);
		const oldBase = oldName.replace(/\.md$/i, "");
		const newBase = file.basename;
		if (!oldBase || oldBase === newBase) return;

		// Give Obsidian's own link updater a beat to finish rewriting regular
		// (non-codeblock) links so we don't race its writes in the same files.
		await new Promise((r) => setTimeout(r, 1000));

		const settings = this.settings;
		const tags = ROLES.map((role) => tagFor(settings, role));
		const linkRe = new RegExp(
			"\\[\\[(?:[^\\]\\n#|]*\\/)?" + escapeRegExpStr(oldBase) + "(?:\\.md)?([#|][^\\]\\n]*)?\\]\\]",
			"gi"
		);
		const oldBaseLC = oldBase.toLowerCase();

		let updatedFiles = 0;
		for (const md of this.app.vault.getMarkdownFiles() as TFile[]) {
			const peek = await this.app.vault.cachedRead(md);
			// Cheap early-out — most files won't mention the old name at all.
			if (!peek.toLowerCase().includes(oldBaseLC)) continue;

			let changed = false;
			await this.app.vault.process(md, (content: string) => {
				let next = content;
				for (const tag of tags) {
					const blockRe = new RegExp("```" + escapeRegExpStr(tag) + "\\n([\\s\\S]*?)```", "gm");
					next = next.replace(blockRe, (full, inner: string) => {
						const rewritten = inner.replace(linkRe, (_m, suffix: string) => `[[${newBase}${suffix || ""}]]`);
						if (rewritten === inner) return full;
						changed = true;
						return "```" + tag + "\n" + rewritten + "```";
					});
				}
				return next;
			});
			if (changed) updatedFiles++;
		}

		if (updatedFiles > 0) {
			new Notice(`Four Winds: updated compass links in ${updatedFiles} note${updatedFiles === 1 ? "" : "s"} ([[${oldBase}]] → [[${newBase}]])`);
		}
	}

	onunload() {
		console.log("Unloading Four Winds...");
		this.app.workspace.detachLeavesOfType(CompassView.VIEW_TYPE);
		this.app.workspace.detachLeavesOfType(NavigationView.VIEW_TYPE);
	}

	async loadSettings() {
		const saved = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

		// Legacy migration: the old `directionLabels` (cardinal keys) was
		// only ever used as a display label that didn't actually drive the
		// admonition tag. The new shape stores per-role names under
		// `directionNames`. Drop the legacy key — it'll be rewritten out of
		// data.json on the next save.
		if ((this.settings as any).directionLabels !== undefined) {
			delete (this.settings as any).directionLabels;
		}

		// Defensive: ensure every role has a name, falling back to the
		// cardinal-direction defaults (which match what's in users' notes).
		if (!this.settings.directionNames || typeof this.settings.directionNames !== "object") {
			this.settings.directionNames = { ...DEFAULT_DIRECTION_NAMES };
		}
		for (const role of ROLES) {
			if (!this.settings.directionNames[role]) {
				this.settings.directionNames[role] = DEFAULT_DIRECTION_NAMES[role];
			}
		}

		// Backfill Discovery keybindings for installs from before they existed.
		if (!this.settings.discoveryKeys || typeof this.settings.discoveryKeys !== "object") {
			this.settings.discoveryKeys = { ...DEFAULT_DISCOVERY_KEYS };
		}
		for (const role of ROLES) {
			if (!this.settings.discoveryKeys[role]) {
				this.settings.discoveryKeys[role] = DEFAULT_DISCOVERY_KEYS[role];
			}
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async activateCompassView() {
		let leaf =
			this.app.workspace.getLeavesOfType(CompassView.VIEW_TYPE)[0] ||
			this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			console.error("No leaf available for Compass View.");
			return;
		}
		await leaf.setViewState({ type: CompassView.VIEW_TYPE });
		this.app.workspace.revealLeaf(leaf);
	}

	async activateNavigationView() {
		let leaf =
			this.app.workspace.getLeavesOfType(NavigationView.VIEW_TYPE)[0] ||
			this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			console.error("No leaf available for Navigation View.");
			return;
		}
		await leaf.setViewState({ type: NavigationView.VIEW_TYPE });
		this.app.workspace.revealLeaf(leaf);
	}

	// Pure additive in both directions:
	//   • OUTGOING — for each link in the active note's own compass blocks,
	//     write the inverse-role link back into that other note. Reciprocates
	//     the relationships you've already declared.
	//   • INCOMING — for each note in the vault that references the active
	//     note inside its compass, add that note to the active note's
	//     inverse-role block.
	// Existing entries are never removed or rewritten; aliased / heading /
	// path-prefixed link forms are normalized for dedup.
	async runAutoLinkCompass() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || activeFile.extension !== "md") {
			new Notice("Open a markdown note first");
			return;
		}

		const settings = this.settings;
		const targetName = activeFile.basename;
		const targetLC = targetName.toLowerCase();

		new Notice(`Auto-linking compass for [[${targetName}]]…`);

		const myContent = await this.app.vault.read(activeFile);
		const myCompass = extractCompassByRole(myContent, settings);

		// === Outgoing pass ===
		// For each (role, otherNote) in my compass, ensure the other note
		// has me in its INVERSE_ROLE block.
		let outgoingAdded = 0;
		let outgoingSkipped = 0;
		let outgoingMissing = 0;

		for (const role of ROLES) {
			const inverseRole = INVERSE_ROLE[role];
			const inverseTag = tagFor(settings, inverseRole);
			for (const otherName of myCompass[role]) {
				if (otherName.toLowerCase() === targetLC) continue;
				const otherFile = this.app.metadataCache.getFirstLinkpathDest(otherName, "");
				if (!otherFile) { outgoingMissing++; continue; }
				const otherContent = await this.app.vault.cachedRead(otherFile);
				const otherCompass = extractCompassByRole(otherContent, settings);
				const alreadyPresent = Array.from(otherCompass[inverseRole]).some(
					(n) => n.toLowerCase() === targetLC
				);
				if (alreadyPresent) { outgoingSkipped++; continue; }
				await addLinkToBlock(this.app, otherFile.path, targetName, inverseTag);
				outgoingAdded++;
			}
		}

		// === Incoming pass ===
		// Scan the vault for notes that reference the active note inside a
		// compass block; for each, add that note to my INVERSE_ROLE block.
		const refs = await findIncomingCompassReferences(
			this.app, settings, targetName, activeFile.path
		);

		let incomingAdded = 0;
		let incomingSkipped = 0;
		// myCompass is still fresh — outgoing pass only modified other files.
		for (const { file: otherFile, role } of refs) {
			const myRole = INVERSE_ROLE[role];
			const otherBase = otherFile.basename;
			const alreadyPresent = Array.from(myCompass[myRole]).some(
				(n) => n.toLowerCase() === otherBase.toLowerCase()
			);
			if (alreadyPresent) { incomingSkipped++; continue; }
			await addLinkToBlock(this.app, activeFile.path, otherBase, tagFor(settings, myRole));
			myCompass[myRole].add(otherBase);
			incomingAdded++;
		}

		// === Summary notice ===
		const totalAdded = outgoingAdded + incomingAdded;
		const totalSkipped = outgoingSkipped + incomingSkipped;
		const hasAnyOutgoing = Object.values(myCompass).some((s) => s.size > 0);

		if (totalAdded === 0) {
			if (refs.length === 0 && !hasAnyOutgoing) {
				new Notice("No compass references to link");
				return;
			}
			const parts: string[] = [];
			if (totalSkipped > 0) parts.push(`${totalSkipped} already linked`);
			if (outgoingMissing > 0) parts.push(`${outgoingMissing} target${outgoingMissing === 1 ? "" : "s"} not found`);
			new Notice(parts.length ? `Auto-link: ${parts.join(", ")}` : "Auto-link: nothing to do");
			return;
		}

		const addedParts: string[] = [];
		if (outgoingAdded > 0) addedParts.push(`${outgoingAdded} outgoing`);
		if (incomingAdded > 0) addedParts.push(`${incomingAdded} incoming`);
		let msg = `Auto-link: added ${addedParts.join(" + ")}`;
		if (totalSkipped > 0) msg += ` (${totalSkipped} already present)`;
		if (outgoingMissing > 0) msg += `; ${outgoingMissing} not found`;
		new Notice(msg);
	}
}
