/**
 * System prompt construction and project context loading
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

const STOP_WORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "should", "must", "when",
	"each", "into", "also", "have", "been", "will", "they", "them", "their", "there",
	"which", "what", "where", "while", "would", "could", "these", "those", "then",
	"than", "some", "more", "other", "only", "just", "like", "such", "make", "made",
	"does", "doing", "being",
]);

function countAcceptanceCriteria(taskText: string): number {
	const section = taskText.match(
		/(?:acceptance\s+criteria|requirements|tasks?|todo):?\s*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|\n(?=##)|$)/i,
	);
	if (!section) {
		const allBullets = taskText.match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
		return allBullets ? Math.min(allBullets.length, 20) : 0;
	}
	const bullets = section[1].match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
	return bullets ? bullets.length : 0;
}

function extractNamedFiles(taskText: string): string[] {
	const matches = taskText.match(/`([^`]+\.[a-zA-Z0-9]{1,6})`/g) || [];
	return [...new Set(matches.map(f => f.replace(/`/g, '').trim()))];
}

function detectFileStyle(cwd: string, relPath: string): string | null {
	try {
		const full = resolve(cwd, relPath);
		if (!existsSync(full)) return null;
		const stat = statSync(full);
		if (!stat.isFile() || stat.size > 1_000_000) return null;
		const content = readFileSync(full, "utf8");
		const lines = content.split("\n").slice(0, 40);
		if (lines.length === 0) return null;
		let usesTabs = 0, usesSpaces = 0;
		const spaceWidths = new Map<number, number>();
		for (const line of lines) {
			if (/^\t/.test(line)) usesTabs++;
			else if (/^ +/.test(line)) {
				usesSpaces++;
				const m = line.match(/^( +)/);
				if (m) { const w = m[1].length; if (w === 2 || w === 4 || w === 8) spaceWidths.set(w, (spaceWidths.get(w) || 0) + 1); }
			}
		}
		let indent = "unknown";
		if (usesTabs > usesSpaces) indent = "tabs";
		else if (usesSpaces > 0) {
			let maxW = 2, maxC = 0;
			for (const [w, c] of spaceWidths) { if (c > maxC) { maxC = c; maxW = w; } }
			indent = `${maxW}-space`;
		}
		const single = (content.match(/'/g) || []).length;
		const double = (content.match(/"/g) || []).length;
		const quotes = single > double * 1.5 ? "single" : double > single * 1.5 ? "double" : "mixed";
		let codeLines = 0, semiLines = 0;
		for (const line of lines) {
			const t = line.trim();
			if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) continue;
			codeLines++;
			if (t.endsWith(";")) semiLines++;
		}
		const semis = codeLines === 0 ? "unknown" : semiLines / codeLines > 0.3 ? "yes" : "no";
		const trailing = /,\s*[\n\r]\s*[)\]}]/.test(content) ? "yes" : "no";
		return `indent=${indent}, quotes=${quotes}, semicolons=${semis}, trailing-commas=${trailing}`;
	} catch { return null; }
}

function shellEscape(s: string): string {
	return s.replace(/[\\"`$]/g, "\\$&");
}

function buildTaskDiscoverySection(taskText: string, cwd: string): string {
	try {
		const keywords = new Set<string>();
		const backticks = taskText.match(/`([^`]{2,80})`/g) || [];
		for (const b of backticks) { const t = b.slice(1, -1).trim(); if (t.length >= 2 && t.length <= 80) keywords.add(t); }
		const camel = taskText.match(/\b[A-Za-z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b/g) || [];
		for (const c of camel) keywords.add(c);
		const snake = taskText.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
		for (const s of snake) keywords.add(s);
		const kebab = taskText.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g) || [];
		for (const k of kebab) keywords.add(k);
		const scream = taskText.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [];
		for (const s of scream) keywords.add(s);
		const pathLike = taskText.match(/(?:^|[\s"'`(\[])((?:\.\.?\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?=$|[\s"'`)\],:;.])/g) || [];
		const paths = new Set<string>();
		for (const p of pathLike) {
			const cleaned = p.trim().replace(/^[\s"'`(\[]/, "").replace(/^\.\//, "");
			paths.add(cleaned);
			keywords.add(cleaned);
		}
		for (const b of backticks) {
			const inner = b.slice(1, -1).trim();
			if (/^[\w./-]+\.[a-zA-Z0-9]{1,6}$/.test(inner) && inner.length < 200) paths.add(inner.replace(/^\.\//, ""));
		}
		const filtered = [...keywords]
			.filter(k => k.length >= 3 && k.length <= 80)
			.filter(k => !/["']/.test(k))
			.filter(k => !STOP_WORDS.has(k.toLowerCase()))
			.slice(0, 20);
		if (filtered.length === 0 && paths.size === 0) return "";

		const fileHits = new Map<string, Set<string>>();
		const includeGlobs =
			'--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" --include="*.py" --include="*.go" --include="*.rs" --include="*.java" --include="*.kt" --include="*.scala" --include="*.dart" --include="*.rb" --include="*.cs" --include="*.cpp" --include="*.c" --include="*.h" --include="*.hpp" --include="*.vue" --include="*.svelte" --include="*.css" --include="*.scss" --include="*.html" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.toml" --include="*.md"';
		for (const kw of filtered) {
			try {
				const escaped = shellEscape(kw);
				const result = execSync(
					`grep -rlF "${escaped}" ${includeGlobs} . 2>/dev/null | grep -v node_modules | grep -v '/\\.git/' | grep -v '/dist/' | grep -v '/build/' | grep -v '/out/' | grep -v '/\\.next/' | grep -v '/target/' | head -12`,
					{ cwd, timeout: 3000, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 },
				).trim();
				if (result) {
					for (const line of result.split("\n")) {
						const file = line.trim().replace(/^\.\//, "");
						if (!file) continue;
						if (!fileHits.has(file)) fileHits.set(file, new Set());
						fileHits.get(file)!.add(kw);
					}
				}
			} catch { }
		}

		const filenameHits = new Map<string, Set<string>>();
		for (const kw of filtered) {
			if (kw.includes("/") || kw.includes(" ") || kw.length > 40) continue;
			try {
				const nameResult = execSync(
					`find . -type f -iname "*${shellEscape(kw)}*" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/.next/*" | head -10`,
					{ cwd, timeout: 2000, encoding: "utf-8", maxBuffer: 1024 * 1024 },
				).trim();
				if (nameResult) {
					for (const line of nameResult.split("\n")) {
						const file = line.trim().replace(/^\.\//, "");
						if (!file) continue;
						if (!filenameHits.has(file)) filenameHits.set(file, new Set());
						filenameHits.get(file)!.add(kw);
						if (!fileHits.has(file)) fileHits.set(file, new Set());
						fileHits.get(file)!.add(kw + " (filename)");
					}
				}
			} catch { }
		}

		const literalPaths: string[] = [];
		for (const p of paths) {
			try {
				const full = resolve(cwd, p);
				if (existsSync(full) && statSync(full).isFile()) literalPaths.push(p.replace(/^\.\//, ""));
			} catch { }
		}

		if (fileHits.size === 0 && literalPaths.length === 0) return "";

		const sorted = [...fileHits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 15);
		const sections: string[] = [];

		sections.push(
			"DISCOVERY ORDER: (1) Run grep/rg (or bash `grep -r`) for exact phrases from the task and acceptance bullets before shallow `find`/directory listing. (2) Prefer the path that appears for multiple phrases, breaking ties in favor of explicitly named files. (3) Use find/ls only for gaps.",
		);

		if (literalPaths.length > 0) {
			sections.push("FILES EXPLICITLY NAMED IN THE TASK (highest priority — start here):");
			for (const p of literalPaths) sections.push(`- ${p}`);
		}

		const sortedFilename = [...filenameHits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 8);
		const shownFiles = new Set(literalPaths);
		const newFilenameHits = sortedFilename.filter(([file]) => !shownFiles.has(file));
		if (newFilenameHits.length > 0) {
			sections.push("\nFILES MATCHING BY NAME (high priority — likely need edits):");
			for (const [file, kws] of newFilenameHits) {
				sections.push(`- ${file} (name matches: ${[...kws].slice(0, 3).join(", ")})`);
				shownFiles.add(file);
			}
		}

		const contentOnly = sorted.filter(([file]) => !shownFiles.has(file));
		if (contentOnly.length > 0) {
			sections.push("\nFILES CONTAINING TASK KEYWORDS:");
			for (const [file, kws] of contentOnly) sections.push(`- ${file} (matches: ${[...kws].slice(0, 4).join(", ")})`);
		} else if (sorted.length > 0) {
			sections.push("\nLIKELY RELEVANT FILES (ranked by task keyword matches):");
			for (const [file, kws] of sorted) sections.push(`- ${file} (matches: ${[...kws].slice(0, 4).join(", ")})`);
		}

		if (sorted.length > 0) {
			const top = sorted[0];
			const second = sorted[1];
			const topCount = top[1].size;
			const secondCount = second ? second[1].size : 0;
			if (topCount >= 3 && (second === undefined || topCount >= secondCount * 2)) {
				sections.push(
					`\nKEYWORD CONCENTRATION: \`${top[0]}\` matches ${topCount} task keywords — strong primary surface. Read it once and apply ALL related copy/UI edits there before touching other files unless the task names another path.`,
				);
			}
		}

		const topFile = literalPaths[0] || sorted[0]?.[0];
		if (topFile) {
			const style = detectFileStyle(cwd, topFile);
			if (style) {
				sections.push(`\nDETECTED STYLE of ${topFile}: ${style}`);
				sections.push("Your edits MUST match this style character-for-character.");
			}
		}

		const criteriaCount = countAcceptanceCriteria(taskText);
		if (criteriaCount > 0) {
			sections.push(`\nThis task has ${criteriaCount} acceptance criteria.`);
			const topMatches = sorted.length > 0 ? sorted[0][1].size : 0;
			const secondMatches = sorted.length > 1 ? sorted[1][1].size : 0;
			const concentrated =
				sorted.length > 0 &&
				topMatches >= 3 &&
				(sorted.length === 1 || topMatches >= secondMatches * 2);
			if (criteriaCount <= 2) {
				sections.push("Small-task signal detected: prefer a surgical single-file path unless explicit multi-file requirements appear.");
				sections.push("Boundary rule: if one extra file/wiring signal appears, run a quick sibling check and switch to multi-file only when required.");
			} else if (concentrated) {
				sections.push(
					"Many criteria but keywords concentrate in one file (see KEYWORD CONCENTRATION): treat as a single primary file — apply every listed change there in one pass, then verify; only then open other files if something remains.",
				);
			} else if (criteriaCount >= 3) {
				sections.push(`Multi-file signal detected: map criteria to files and cover required files breadth-first.`);
			}
		}
		sections.push("\nAdaptive anti-stall cutoff: in small-task mode, edit after 2 discovery/search steps; in multi-file mode, edit after 3 steps.");
		const namedFiles = extractNamedFiles(taskText);
		if (namedFiles.length > 0) {
			sections.push(`\nFiles named in the task text: ${namedFiles.map(f => `\`${f}\``).join(", ")}.`);
			sections.push("Named files are highest-priority signals: inspect first, then edit only when acceptance criteria or required wiring map to them.");
		}
		sections.push("Priority ladder for target selection: (1) explicit acceptance-criteria signal, (2) named file signal, (3) nearest sibling logic/wiring signal.");
		sections.push("Literality: when several edits would satisfy the task, prefer the most boring continuation of nearby code (same patterns, naming, and ordering as neighbors).");

		return "\n\n" + sections.join("\n") + "\n";
	} catch { }
	return "";
}

// Dual-mode diff-overlap preamble injected on every invocation.
// Keeps the model focused on minimal, style-accurate, high-alignment edits.
// Surgical-diff protocol injected on every invocation.
// Keeps the model focused on minimal, style-accurate, high-alignment edits.
const TAU_SCORING_PREAMBLE_FOR_MAIN_BRANCH = `## Hard constraints

- Start with a tool call immediately.
- **One file at a time:** Read one file, edit it immediately, then read the next. Never batch multiple file READS in the same turn — file content floods context and causes provider errors. Bash/grep commands may run freely in any quantity (they return snippets, not full content).
- Do not install packages unless the task explicitly names a dependency to add.
- **Complete coverage is law.** Touch every line the criteria require — no more, no less. Surplus inflates denominator. Omissions lose the entire file's lines. Coverage beats compression.
- **Non-empty patch:** Finish with at least one successful \`edit\` or \`write\`. Text-only output = 0 points. A wrong edit always outscores an empty diff.

## Scoring

score = matched_lines / max(your_diff_lines, reference_diff_lines)

Two loss modes:
1. **Surplus** — you changed lines the reference did not → denominator grows → score drops.
2. **Misalignment** — you changed the right lines but wrong whitespace/quotes/ordering → zero credit.

## Execution Protocol

1. Parse task. Count acceptance criteria sentence by sentence. Decompose compound criteria ("X and also Y") into atomic sub-items. Each maps to at least one file edit.
2. **Edit-first when the file is known.** If the task names a file explicitly (in backticks or path format) AND the discovery section above lists matching files → go straight to it: read it once, then edit immediately. Skip bash discovery for that file. Only run bash discovery (\`grep -rn\` + \`find\`) when NO file is named or discoverable. **Discovery cap = 3 bash calls** then pick best match and edit.
3. Read EVERY target file before editing. ONE FILE AT A TIME: read → edit → next file. Note style conventions exactly.
4. Breadth-first in **alphabetical file order**: one correct edit per file, then move on. Never >3 consecutive edits on same file when others need changes. Touching 4 of 5 target files scores far higher than perfecting 1 of 5.
5. After each edit, run \`ls $(dirname path)/\` — sibling files often need the same change. If a sibling has an analogous pattern (same export shape, same config structure, same test layout), apply the corresponding edit to it too. This catches 10-20% of missed lines.
6. After last edit, walk the criterion checklist one more time.
7. Stop. No verification reads, no summaries, no second passes.
8. **Budget rule:** By your 5th tool call, you MUST have made at least 1 edit/write. If not — stop ALL discovery and make your best-guess edit RIGHT NOW. Context overflow = guaranteed zero score.

## Diff Precision

- Character-identical style: copy indentation, quotes, semicolons, trailing commas exactly.
- Literality rule — prefer the most boring, literal continuation of nearby code (same patterns, naming, ordering).
- When appending to arrays or lists, add to the END — not mid-array (matches reference diff ordering).
- No exploratory reads: skip README, package.json, tsconfig unless task names them.
- No re-reading: once read, don't read again unless an edit failed.
- Alphabetical file order for multi-file edits.
- Prefer narrowest replacement: single token > single line > whole block.
- Data files (.json, config, env) and test files count in scoring — do not skip them.

## Edit failure recovery

Edit rejected → re-read the file once, retry with corrected oldText. Never retry from memory.
File not found → grep -rn any task keyword, edit closest match.
Multiple failures → widen the read, verify the path, try a different unique substring.
**A wrong edit beats silence. An imperfect edit always outscores empty diff.**
`;

const TAU_SCORING_PREAMBLE_FOR_CUSTOM_BRANCH = `## WRITE-FIRST LAW (HIGHEST PRIORITY)

If the task names or implies a file path — attempt the edit on your FIRST tool call.
Do NOT run bash. Do NOT run read. Do NOT run find. Do NOT run grep. WRITE FIRST.
Read ONLY if the write/edit fails (file not found, anchor not matched).

Example: Task says "add a gender toggle to the lab references page"
→ Your FIRST tool call: edit src/app/(dashboard)/lab/references/page.tsx immediately.
Infer the change from the task description + file name + common code patterns.

Example: Task says "update the consensus aux_data module"
→ Your FIRST tool call: edit the file at the path implied by the module name.

You do NOT need to read a file to edit it. The task description tells you WHAT to change.
The file path tells you WHERE. Common patterns tell you HOW. Write blind. Fix on failure.

## Hard constraints

- Your FIRST tool call must be an edit or write. Always.
- **One file at a time.** Edit one file, then move to the next.
- Do not install packages unless the task explicitly names a dependency to add.
- **Complete coverage is law.** Touch every line the criteria require — no more, no less.
- **Non-empty patch:** Finish with at least one successful \`edit\` or \`write\`. Text-only output = 0 points. A wrong edit always outscores an empty diff.
- **NEVER give up.** If you cannot find a file or are unsure — make your best-guess edit anyway. Silence = 0 points. A wrong edit > no edit.
- **NEVER write code in your text response.** ALL code changes MUST be made via edit or write tool calls. Putting code in text instead of tool calls = 0 points.

## Scoring

score = matched_lines / max(your_diff_lines, reference_diff_lines)

Two loss modes:
1. **Surplus** — you changed lines the reference did not → denominator grows → score drops.
2. **Misalignment** — you changed the right lines but wrong whitespace/quotes/ordering → zero credit.

## Execution Protocol

STEP 1: Read the task. Find every file path or symbol named.
STEP 2: For each named file — attempt the edit IMMEDIATELY on your first tool call.
  - Do NOT read the file first.
  - Infer the change from the task description + file name + common patterns.
  - If edit fails (file not found / anchor not unique) → THEN read the file once and retry.
STEP 3: For unnamed symbols — ONE grep -rn for the symbol, then edit immediately.
STEP 4: After each edit, run \`ls $(dirname path)/\` — sibling files often need the same change. Apply analogous edits to siblings.
STEP 5: Breadth-first in alphabetical file order. Touching 4 of 5 target files scores far higher than perfecting 1 of 5.
STEP 5.5: After every successful edit, IMMEDIATELY check: are there other acceptance criteria not yet covered? If yes → move to the next file and edit it. Do NOT stop after the first file. Cover ALL criteria breadth-first.
STEP 6: Stop. No verification reads, no summaries, no second passes.

**Budget rule:** By your 3rd tool call, you MUST have made at least 1 edit/write. If not — stop ALL discovery and make your best-guess edit RIGHT NOW. Context overflow = guaranteed zero score.

## Diff Precision

- Character-identical style: copy indentation, quotes, semicolons, trailing commas exactly.
- Literality rule — prefer the most boring, literal continuation of nearby code (same patterns, naming, ordering).
- When appending to arrays or lists, add to the END — not mid-array (matches reference diff ordering).
- No exploratory reads: skip README, package.json, tsconfig unless task names them.
- No re-reading: once read, don't read again unless an edit failed.
- Alphabetical file order for multi-file edits.
- Prefer narrowest replacement: single token > single line > whole block.
- Data files (.json, config, env) and test files count in scoring — do not skip them.

## Edit failure recovery

Edit rejected → re-read the file once, retry with corrected oldText. Never retry from memory.
File not found → grep -rn any task keyword, edit closest match.
Multiple failures → widen the read, verify the path, try a different unique substring.
**A wrong edit beats silence. An imperfect edit always outscores empty diff.**
**NEVER conclude "not enough information." ALWAYS attempt an edit.**
`;

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, grep, find, ls, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const discoverySection = customPrompt ? buildTaskDiscoverySection(customPrompt, resolvedCwd) : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = TAU_SCORING_PREAMBLE_FOR_CUSTOM_BRANCH + discoverySection + customPrompt;

		if (appendSection) {
			prompt += "\n\n# Appended Section\n\n";
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += "\n\n# Skilled Section\n\n";
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "grep", "find", "ls", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant (Diff Overlap Optimizer) operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.
Your diff is scored against a hidden reference diff for the same task.
Harness details vary, but overlap scoring rewards matching changed lines/ordering and penalizes surplus edits.
No semantic bonus. No tests in scoring.
**Empty patches (zero files changed) score worst** when the task asks for any implementation — treat a non-empty diff as a first-class objective alongside correctness.

## Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

## Guidelines:
${guidelines}
`;

	prompt += TAU_SCORING_PREAMBLE_FOR_MAIN_BRANCH

	// 	prompt += `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
	// - Main documentation: ${readmePath}
	// - Additional docs: ${docsPath}
	// - Examples: ${examplesPath} (extensions, custom tools, SDK)
	// - When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
	// - When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
	// - Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += "\n\n## Appended Section\n\n";
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n## Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `### ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += "\n\n## Skilled Section\n\n";
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
