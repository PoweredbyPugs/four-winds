import { Plugin, ItemView, WorkspaceLeaf } from "obsidian";
import * as cytoscapeImport from "cytoscape";
const cytoscapeFn = (cytoscapeImport as any).default ? (cytoscapeImport as any).default : cytoscapeImport;

// Extend the App type to include plugins
declare module "obsidian" {
    interface App {
        plugins: {
            getPlugin: (id: string) => any;
        };
    }
}

class CompassView extends ItemView {
    static VIEW_TYPE = "compass-view";

    private plugin: CompassPlugin;
    private renderTimeout: number | null = null; // For debouncing

    constructor(leaf: WorkspaceLeaf, plugin: CompassPlugin) {
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
        // Debounce the render to avoid excessive calls
        this.cleanupRenderTimeout();
        this.renderTimeout = window.setTimeout(() => {
            this.render();
        }, 300); // 300ms delay to stabilize rendering
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

            const directions = ["north", "south", "east", "west"];

            // Map to store links per direction
            const directionLinks: Record<string, Set<string>> = {
                north: new Set(),
                south: new Set(),
                east: new Set(),
                west: new Set(),
            };

            // Fetch all dynamic links first
            await Promise.all(
                directions.map(async (dir) => {
                    if (dir === "north") {
                        const dynamicLinks = await this.fetchDynamicLinks("ad-south", activeFile.name);
                        dynamicLinks.forEach((link) => directionLinks[dir].add(link));
                    } else if (dir === "south") {
                        const dynamicLinks = await this.fetchDynamicLinks("ad-north", activeFile.name);
                        dynamicLinks.forEach((link) => directionLinks[dir].add(link));
                    } else if (dir === "east") {
                        const dynamicLinks = await this.fetchDynamicLinks("ad-east", activeFile.name);
                        dynamicLinks.forEach((link) => directionLinks[dir].add(link));
                    } else if (dir === "west") {
                        const dynamicLinks = await this.fetchDynamicLinks("ad-west", activeFile.name);
                        dynamicLinks.forEach((link) => directionLinks[dir].add(link));
                    }
                })
            );

            // Process each direction
            directions.forEach((dir) => {
                const section = container.createEl("div", { cls: "compass-section" });
				section.createEl("hr", { text: "" });
                section.createEl("h6", { text: dir.toLowerCase()});


                // Add hardcoded links
                const hardcodedLinks = this.extractHardcodedLinks(dir, content);
                hardcodedLinks.forEach((link) => directionLinks[dir].add(link));

                // Render all unique links
                const allLinks = Array.from(directionLinks[dir]);
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
                    section.createEl("p", { text: "..." }); // No links found
                }
            });

            console.log("Compass View rendered successfully.");
        } catch (error) {
        }
    }

    private extractHardcodedLinks(direction: string, content: string): string[] {
        const regex = new RegExp(
            `\`\`\`ad-${direction}\\n([\\s\\S]*?)\`\`\``,
            "gm"
        );
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

    private async fetchDynamicLinks(admonitionType: string, currentFile: string): Promise<string[]> {
        try {
            const dv = this.app.plugins.getPlugin("dataview");
            if (!dv) throw new Error("Dataview plugin is not enabled or not available.");

            const allNotes = dv.api.pages();
            const result = new Set<string>();

            for (const note of allNotes) {
                const content = await dv.api.io.load(note.file.path) || "";

                const regex = new RegExp(
                    `\`\`\`${admonitionType}[\\s\\S]*?\\[\\[${currentFile}\\]\\][\\s\\S]*?\`\`\``,
                    "gm"
                );
                const matches = content.match(regex);

                if (matches) {
                    result.add(note.file.name);
                }
            }

            return Array.from(result).sort();
        } catch (error) {
            return [];
        }
    }
}

/*──────────────────────────────────────────────
Navigation View Code
──────────────────────────────────────────────*/
class NavigationView extends ItemView {
	static VIEW_TYPE = "navigation-view";
	plugin: CompassPlugin; // reusing your existing plugin instance
	cy: cytoscape.Core | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: CompassPlugin) {
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
		// Re-render whenever a new file is opened.
		this.registerEvent(this.app.workspace.on("file-open", () => this.render()));
		this.render();
	}

	async onClose() {
		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}
	}

	/**
	 * Renders the Navigation View using Cytoscape.js.
	 *
	 * - Creates a Cytoscape container inside this.contentEl.
	 * - Displays a central node representing the active note (with its trailing ".md" removed).
	 * - For each admonition direction ("north", "east", "south", "west"),
	 *   extracts first-degree branch nodes and positions them relative to the central node.
	 * - Connects each branch node to the central node via an edge.
	 * - For each branch node, loads its note and extracts secondary links (2nd-degree nodes)
	 *   positioned relative to the branch node (as if it were a new center).
	 * - Secondary nodes are styled with very low default opacity.
	 * - Panning, zooming, and dragging are enabled.
	 * - Hovering over any node lowers the opacity of all nodes except the hovered node and its immediate neighbors.
	 */
	async render() {
		// Use the view's content element.
		const container = this.contentEl;
		container.empty();

		// Destroy any existing Cytoscape instance.
		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}

		// Get the active file.
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			container.createEl("p", { text: "No active note selected." });
			return;
		}

		// Create a container div for Cytoscape.
		const cyContainer = container.createDiv({ cls: "navigation-cy-container" });
		cyContainer.style.width = "100%";
		cyContainer.style.height = "100%";

		// Extract the file name: remove trailing ".md" only.
		let fileName = activeFile.name;
		if (fileName.toLowerCase().endsWith(".md")) {
			fileName = fileName.slice(0, -3);
		}

		// Compute center positions based on container dimensions.
		const width = cyContainer.clientWidth || 600;
		const height = cyContainer.clientHeight || 400;
		const centerX = width / 2;
		const centerY = height / 2;

		// Build arrays for nodes and edges.
		let nodes: cytoscape.ElementDefinition[] = [];
		let edges: cytoscape.ElementDefinition[] = [];

		// Create the central node (color: #c7b194).
		nodes.push({
			data: { id: "central", label: fileName, type: "central" },
			position: { x: centerX, y: centerY }
		});

		// Read the active file's content.
		const content = await this.app.vault.cachedRead(activeFile);

		// Process the four admonition directions for first-degree branch nodes.
		const directions = ["north", "east", "south", "west"];
		const offsetConfig: Record<string, { baseOffset: number; spacing: number; isVertical: boolean; sign: number }> = {
			north: { baseOffset: 150, spacing: 50, isVertical: false, sign: -1 },
			south: { baseOffset: 150, spacing: 50, isVertical: false, sign: 1 },
			east:  { baseOffset: 150, spacing: 50, isVertical: true,  sign: 1 },
			west:  { baseOffset: 150, spacing: 50, isVertical: true,  sign: -1 }
		};

		directions.forEach((dir) => {
			const regex = new RegExp("```ad-" + dir + "\\n([\\s\\S]*?)```", "gm");
			let branchLinks: string[] = [];
			let match;
			while ((match = regex.exec(content)) !== null) {
				const admonitionContent = match[1];
				const linkRegex = /\[\[(.*?)\]\]/g;
				let linkMatch;
				while ((linkMatch = linkRegex.exec(admonitionContent)) !== null) {
					let linkName = linkMatch[1].trim();
					if (linkName.toLowerCase().endsWith(".md")) {
						linkName = linkName.slice(0, -3);
					}
					branchLinks.push(linkName);
				}
			}
			if (branchLinks.length > 0) {
				branchLinks.forEach((link, i) => {
					let posX = centerX;
					let posY = centerY;
					const config = offsetConfig[dir];
					if (config.isVertical) {
						posX = centerX + config.baseOffset * config.sign;
						posY = centerY + (i - (branchLinks.length - 1) / 2) * config.spacing;
					} else {
						posY = centerY + config.baseOffset * config.sign;
						posX = centerX + (i - (branchLinks.length - 1) / 2) * config.spacing;
					}
					const nodeId = `${dir}_${i}`;
					nodes.push({
						data: { id: nodeId, label: link, type: "branch", direction: dir },
						position: { x: posX, y: posY }
					});
					edges.push({
						data: { id: `edge_${dir}_${i}`, source: "central", target: nodeId }
					});
				});
			}
		});

		// Initialize Cytoscape with first-degree nodes.
		this.cy = cytoscapeFn({
			container: cyContainer,
			elements: [
				...nodes,
				...edges
			],
			style: [
				{
					selector: 'node[type="central"]',
					style: {
						'background-color': '#c7b194',
						'width': '30px',
						'height': '30px',
						'label': 'data(label)',
						'text-valign': 'bottom',
						'text-halign': 'center',
						'text-margin-y': 8,
						'font-size': '12px',
						'color': '#fff'
					}
				},
				{
					selector: 'node[type="branch"][direction="north"]',
					style: {
						'background-color': '#607c87',
						'width': '15px',
						'height': '15px',
						'label': 'data(label)',
						'text-valign': 'bottom',
						'text-halign': 'center',
						'text-margin-y': 8,
						'font-size': '10px',
						'color': '#fff'
					}
				},
				{
					selector: 'node[type="branch"][direction="east"]',
					style: {
						'background-color': '#76b12b',
						'width': '15px',
						'height': '15px',
						'label': 'data(label)',
						'text-valign': 'bottom',
						'text-halign': 'center',
						'text-margin-y': 8,
						'font-size': '10px',
						'color': '#fff'
					}
				},
				{
					selector: 'node[type="branch"][direction="south"]',
					style: {
						'background-color': '#c7b194',
						'width': '15px',
						'height': '15px',
						'label': 'data(label)',
						'text-valign': 'bottom',
						'text-halign': 'center',
						'text-margin-y': 8,
						'font-size': '10px',
						'color': '#fff'
					}
				},
				{
					selector: 'node[type="branch"][direction="west"]',
					style: {
						'background-color': '#f0533f',
						'width': '15px',
						'height': '15px',
						'label': 'data(label)',
						'text-valign': 'bottom',
						'text-halign': 'center',
						'text-margin-y': 8,
						'font-size': '10px',
						'color': '#fff'
					}
				},
				{
					selector: 'node[type="secondary"]',
					style: {
						'background-color': '#999999',
						'width': '10px',
						'height': '10px',
						'label': 'data(label)',
						'text-valign': 'bottom',
						'text-halign': 'center',
						'text-margin-y': 5,
						'font-size': '8px',
						'color': '#fff',
						'opacity': 0.1 // Default low opacity
					}
				},
				{
					selector: 'edge',
					style: {
						'width': '1px',
						'line-color': '#917959',
						'target-arrow-shape': 'triangle',
						'target-arrow-color': '#917959',
						'curve-style': 'bezier'
					}
				}
			],
			layout: { name: 'preset' },
			userPanningEnabled: true,
			userZoomingEnabled: true,
			boxSelectionEnabled: false
		});

		// Enable node dragging.
		this.cy!.nodes().grabify();

		// Attach click events to nodes.
		this.cy!.on('tap', 'node', (event: cytoscape.EventObject) => {
			const node = event.target;
			const data = node.data();
			if (data.type === "central") {
				this.app.workspace.openLinkText(activeFile.name, "");
			} else if (data.type === "branch" || data.type === "secondary") {
				this.app.workspace.openLinkText(data.label, "");
			}
		});

		// Hover interaction: on mouseover, reduce opacity of all elements except the hovered node and its neighborhood.
		this.cy!.on('mouseover', 'node', (event: cytoscape.EventObject) => {
			const node = event.target;
			this.cy!.elements().style('opacity', 0.2);
			node.style('opacity', 1);
			node.connectedEdges().style('opacity', 1);
			node.neighborhood().style('opacity', 1);
		});
		// On mouseout, restore opacity for all nodes—but secondary nodes go back to low opacity.
		this.cy!.on('mouseout', 'node', (event: cytoscape.EventObject) => {
			this.cy!.nodes().forEach(n => {
				if(n.data('type') === 'secondary'){
					n.style('opacity', 0.1);
				} else {
					n.style('opacity', 1);
				}
			});
			this.cy!.edges().style('opacity', 1);
		});

		// For each branch node, process its note to add secondary (2nd degree) nodes.
		this.cy!.nodes('[type="branch"]').forEach((branchNode: cytoscape.NodeSingular) => {
			this.processBranchNode(branchNode);
		});
	}

	/**
	 * Processes a branch node by loading its note content and adding secondary nodes.
	 * Secondary nodes are arranged relative to the branch node as if it were a new center,
	 * and are added with low default opacity.
	 */
	async processBranchNode(branchNode: cytoscape.NodeSingular): Promise<void> {
		const branchData = branchNode.data();
		const branchNoteName = branchData.label;
		const branchDirection = branchData.direction;
		// Locate the note from the vault.
		const branchFile = this.app.metadataCache.getFirstLinkpathDest(branchNoteName, "");
		if (branchFile) {
			const branchContent = await this.app.vault.cachedRead(branchFile);
			// Look for the admonition block for the branch's direction.
			const regex = new RegExp("```ad-" + branchDirection + "\\n([\\s\\S]*?)```", "gm");
			const match = regex.exec(branchContent);
			if (match) {
				const admonitionContent = match[1];
				const linkRegex = /\[\[(.*?)\]\]/g;
				let linkMatch;
				let secondaryLinks: string[] = [];
				while ((linkMatch = linkRegex.exec(admonitionContent)) !== null) {
					let secLink = linkMatch[1].trim();
					if (secLink.toLowerCase().endsWith(".md")) {
						secLink = secLink.slice(0, -3);
					}
					secondaryLinks.push(secLink);
				}
				// Position secondary nodes relative to the branch node.
				const branchPos = branchNode.position();
				// Configuration for secondary nodes (using the branch node as center).
				const secondaryOffsetConfig: Record<string, { baseOffset: number; spacing: number; isVertical: boolean; sign: number }> = {
					north: { baseOffset: 100, spacing: 30, isVertical: false, sign: -1 },
					south: { baseOffset: 100, spacing: 30, isVertical: false, sign: 1 },
					east:  { baseOffset: 100, spacing: 30, isVertical: true,  sign: 1 },
					west:  { baseOffset: 100, spacing: 30, isVertical: true,  sign: -1 }
				};
				const secConfig = secondaryOffsetConfig[branchDirection];
				secondaryLinks.forEach((secLink, i) => {
					let secX = branchPos.x;
					let secY = branchPos.y;
					if (secConfig.isVertical) {
						secX = branchPos.x + secConfig.baseOffset * secConfig.sign;
						secY = branchPos.y + (i - (secondaryLinks.length - 1) / 2) * secConfig.spacing;
					} else {
						secY = branchPos.y + secConfig.baseOffset * secConfig.sign;
						secX = branchPos.x + (i - (secondaryLinks.length - 1) / 2) * secConfig.spacing;
					}
					const secNodeId = branchData.id + "_sec_" + i;
					// Add secondary node without a parent, so it is independent.
					this.cy!.add({
						group: 'nodes',
						data: { id: secNodeId, label: secLink, type: "secondary" },
						position: { x: secX, y: secY }
					});
					this.cy!.add({
						group: 'edges',
						data: { id: secNodeId + "_edge", source: branchData.id, target: secNodeId }
					});
				});
			}
		}
	}
}
/*──────────────────────────────────────────────
   Plugin Registration (Combined)
──────────────────────────────────────────────*/

/**
 * CompassPlugin is your main plugin class.
 * It registers both the Compass View and the new Navigation View.
 */
export default class CompassPlugin extends Plugin {
	async onload() {
		console.log("Loading CompassPlugin...");

		// Register the Compass View (your existing view)
		this.registerView(CompassView.VIEW_TYPE, (leaf) => new CompassView(leaf, this));

		// Register the new Navigation View
		this.registerView(NavigationView.VIEW_TYPE, (leaf) => new NavigationView(leaf, this));

		// Add command to open the Compass View.
		this.addCommand({
			id: "open-compass-view",
			name: "Open Compass View",
			callback: () => this.activateCompassView(),
		});

		// Add command to open the Navigation View.
		this.addCommand({
			id: "open-navigation-view",
			name: "Open Navigation View",
			callback: () => this.activateNavigationView(),
		});

		// Optionally, activate one of the views on load.
		this.activateCompassView();
	}

	onunload() {
		console.log("Unloading CompassPlugin...");
		this.app.workspace.detachLeavesOfType(CompassView.VIEW_TYPE);
		this.app.workspace.detachLeavesOfType(NavigationView.VIEW_TYPE);
	}

	/**
	 * Activates the Compass View in a workspace leaf.
	 */
	async activateCompassView() {
		// Try to find an existing leaf; otherwise, get one from the right sidebar.
		let leaf = this.app.workspace.getLeavesOfType(CompassView.VIEW_TYPE)[0] ||
			this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			console.error("No leaf available for Compass View.");
			return;
		}
		await leaf.setViewState({ type: CompassView.VIEW_TYPE });
		this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Activates the Navigation View in its own right sidebar leaf.
	 */
	async activateNavigationView() {
		// Try to find an existing leaf; otherwise, get one from the right sidebar.
		let leaf = this.app.workspace.getLeavesOfType(NavigationView.VIEW_TYPE)[0] ||
			this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			console.error("No leaf available for Navigation View.");
			return;
		}
		await leaf.setViewState({ type: NavigationView.VIEW_TYPE });
		this.app.workspace.revealLeaf(leaf);
	}
}