/**
 * Tierra-v38 — nexus-v3 discovery (verbatim + EXCLUDED_FILE_PATTERNS), nexus-v3 preamble
 *
 * Root cause fixes:
 * 1. BUDGET_MS removed — each keyword gets unrestricted time (per-keyword timeout:3000ms)
 * 2. Early return fixed — literalPaths checked before returning "" (nexus-v3 pattern)
 * 3. grep pattern: double-quote escape + JS-level timeout + maxBuffer:2MB (nexus-v3)
 * 4. Keywords 12→20 (nexus-v3)
 * 5. Files shown 5→15 (nexus-v3)
 * 6. DISCOVERY ORDER + adaptive anti-stall + priority ladder in discovery output
 * 7. Preamble: nexus-v3's "#1 Rule: Completeness wins" + numbered execution protocol
 * 8. Checkbox final gate
 *
 * Build: 2026-04-22 by T68Bot (nexus-v3 proven at 0.220 — copy verbatim)
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

// ─── Constants ─────────────────────────────────────────────────────────────

const EXCLUDED_FILE_PATTERNS = /package-lock|yarn\.lock|pnpm-lock|\.d\.ts$|\.min\.(js|css)$|\.map$|generated|__generated__|\.snap$|\.svg$|CHANGELOG|LICENSE/i;

const STOP_WORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "should", "must", "when",
	"each", "into", "also", "have", "been", "will", "they", "them", "their", "there",
	"which", "what", "where", "while", "would", "could", "these", "those", "then",
	"than", "some", "more", "other", "only", "just", "like", "such", "make", "made",
	"does", "doing", "being",
]);

// ─── Utility ───────────────────────────────────────────────────────────────

function shellEscape(s: string): string {
	return s.replace(/[\\"`$]/g, "\\$&");
}

// ─── Keyword extraction (our version — better edge-case handling) ───────────

function extractKeywords(taskText: string): string[] {
	const keywords = new Set<string>();

	const backtickMatches = taskText.match(/`([^`]+)`/g);
	if (backtickMatches) {
		for (const m of backtickMatches) {
			const inner = m.slice(1, -1).trim();
			if (inner.length >= 2 && inner.length <= 80) keywords.add(inner);
		}
	}

	const camelMatches = taskText.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g);
	if (camelMatches) for (const m of camelMatches) keywords.add(m);

	const pascalMatches = taskText.match(/\b[A-Z][a-z]+[A-Z][a-zA-Z0-9]*\b/g);
	if (pascalMatches) for (const m of pascalMatches) keywords.add(m);

	const snakeMatches = taskText.match(/\b[a-z][a-z0-9]*_[a-z][a-z0-9_]*\b/g);
	if (snakeMatches) for (const m of snakeMatches) keywords.add(m);

	const kebabMatches = taskText.match(/\b[a-z][a-z0-9]*-[a-z][a-z0-9-]*\b/g);
	if (kebabMatches) for (const m of kebabMatches) keywords.add(m);

	const screamingMatches = taskText.match(/\b[A-Z][A-Z0-9]*_[A-Z][A-Z0-9_]*\b/g);
	if (screamingMatches) for (const m of screamingMatches) keywords.add(m);

	const pathMatches = taskText.match(/(?:[\w.-]+\/)+[\w.-]+/g);
	if (pathMatches) for (const m of pathMatches) keywords.add(m);

	const extMatches = taskText.match(/\b[\w-]+\.\w{1,6}\b/g);
	if (extMatches) {
		for (const m of extMatches) {
			if (/\.(ts|tsx|js|jsx|py|css|json|html|vue|svelte|go|rs|java|kt|swift|dart|php|rb|cs|cpp|h|sql|yaml|yml|md|sh|toml)$/i.test(m)) {
				keywords.add(m);
			}
		}
	}

	const result: string[] = [];
	for (const kw of keywords) {
		if (kw.length >= 3 && !STOP_WORDS.has(kw.toLowerCase())) result.push(kw);
	}
	const deduped = [...new Set(result)];
	// Prioritize paths and long identifiers first — most specific keywords first
	deduped.sort((a, b) => {
		const aIsPath = a.includes("/") || (a.includes(".") && a.length > 4);
		const bIsPath = b.includes("/") || (b.includes(".") && b.length > 4);
		if (aIsPath && !bIsPath) return -1;
		if (!aIsPath && bIsPath) return 1;
		return b.length - a.length;
	});
	return deduped.slice(0, 20);
}

// ─── Named file extractor ──────────────────────────────────────────────────

function extractNamedFiles(taskText: string): string[] {
	const matches = taskText.match(/`([^`]+\.[a-zA-Z0-9]{1,6})`/g) || [];
	return [...new Set(matches.map(f => f.replace(/`/g, '').trim()))];
}

// ─── Acceptance criteria counter ──────────────────────────────────────────

function countAcceptanceCriteria(taskText: string): number {
	const section = taskText.match(
		/(?:acceptance\s+criteria|requirements|tasks?|todo):?\s*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|\n(?=##)|$)/i,
	);
	if (!section) {
		const allBullets = taskText.match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
		return allBullets ? Math.min(allBullets.length, 20) : 0;
	}
	const bullets = section[1].match(/^\s*(?:[-*•+]|\d+[.)]\s)/gm);
	return bullets ? bullets.length : 0;
}

// ─── Style detection (nexus-v3 version — returns compact string) ────────────

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

// ─── Discovery section (nexus-v3 verbatim + EXCLUDED_FILE_PATTERNS) ────────

function buildTaskDiscoverySection(taskText: string, cwd: string): string {
	try {
		const keywords = extractKeywords(taskText);
		const paths = new Set<string>();

		// Extract literal path references from task text
		const pathLike = taskText.match(/(?:^|[\s"'`(\[])((?:\.\.?\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?=$|[\s"'`)\],:;.])/g) || [];
		for (const p of pathLike) {
			const cleaned = p.trim().replace(/^[\s"'`(\[]/, "").replace(/^\.\//, "");
			paths.add(cleaned);
		}
		// Also extract backtick file references
		const backticks = taskText.match(/`([^`]{2,80})`/g) || [];
		for (const b of backticks) {
			const inner = b.slice(1, -1).trim();
			if (/^[\w./-]+\.[a-zA-Z0-9]{1,6}$/.test(inner) && inner.length < 200) paths.add(inner.replace(/^\.\//, ""));
		}

		const filtered = keywords
			.filter(k => k.length >= 3 && k.length <= 80)
			.filter(k => !/["']/.test(k))
			.filter(k => !STOP_WORDS.has(k.toLowerCase()));

		if (filtered.length === 0 && paths.size === 0) return "";

		const includeGlobs =
			'--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" --include="*.py" --include="*.go" --include="*.rs" --include="*.java" --include="*.kt" --include="*.scala" --include="*.dart" --include="*.rb" --include="*.cs" --include="*.cpp" --include="*.c" --include="*.h" --include="*.hpp" --include="*.vue" --include="*.svelte" --include="*.css" --include="*.scss" --include="*.html" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.toml" --include="*.md"';

		const fileHits = new Map<string, Set<string>>();
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
						if (!file || EXCLUDED_FILE_PATTERNS.test(file)) continue;
						if (!fileHits.has(file)) fileHits.set(file, new Set());
						fileHits.get(file)!.add(kw);
					}
				}
			} catch {}
		}

		// Verify literal paths exist on disk
		const literalPaths: string[] = [];
		for (const p of paths) {
			try {
				const full = resolve(cwd, p);
				if (existsSync(full) && statSync(full).isFile()) literalPaths.push(p.replace(/^\.\//, ""));
			} catch {}
		}

		// FIX: return "" only when BOTH grep AND literal paths yield nothing
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

		if (sorted.length > 0) {
			sections.push("\nLIKELY RELEVANT FILES (ranked by task keyword matches):");
			for (const [file, kws] of sorted) sections.push(`- ${file} (matches: ${[...kws].slice(0, 4).join(", ")})`);
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
			if (criteriaCount <= 2) {
				sections.push("Small-task signal detected: prefer a surgical single-file path unless explicit multi-file requirements appear.");
				sections.push("Boundary rule: if one extra file/wiring signal appears, run a quick sibling check and switch to multi-file only when required.");
			}
			if (criteriaCount >= 3) sections.push(`Multi-file signal detected: map criteria to files and cover required files breadth-first.`);
		}
		sections.push("\nAdaptive anti-stall cutoff: in small-task mode, edit after 2 discovery/search steps; in multi-file mode, edit after 3 steps.");
		const namedFiles = extractNamedFiles(taskText);
		if (namedFiles.length > 0) {
			sections.push(`\nFiles named in the task text: ${namedFiles.map(f => `\`${f}\``).join(", ")}.`);
			sections.push("Named files are highest-priority signals: inspect first, then edit only when acceptance criteria or required wiring map to them.");
		}
		sections.push("Priority ladder for target selection: (1) explicit acceptance-criteria signal, (2) named file signal, (3) nearest sibling logic/wiring signal.");
		sections.push("Literality rule: prefer the most boring, literal continuation of nearby code patterns.");

		return "\n\n" + sections.join("\n") + "\n";
	} catch {}
	return "";
}

// ─── Scoring Preamble (nexus-v3 proven at 0.220) ──────────────────────────

const TAU_SCORING_PREAMBLE = `# Diff Overlap Optimizer

Your diff is scored against a hidden reference diff for the same task.
Overlap scoring rewards matching changed lines/ordering and penalizes surplus edits.
No semantic bonus. No tests in scoring.

## #1 Rule — Completeness wins

The single most important thing: implement **every** acceptance criterion and **every** sub-part of each criterion. Missing a feature is far worse than adding a few extra lines. Read each criterion carefully — "X and also Y" means both X and Y need code. Behavioral requirements need working logic, not stubs.

## Hard constraints

- Do not run tests, builds, linters, formatters, servers, or git operations.
- Runtime guardrails are enforced in the agent loop; if a tool call is blocked, correct course immediately.
- Read a file before editing it.
- Implement only what is explicitly requested — but implement ALL of it.
- Literality rule: choose the most boring, literal continuation of nearby code patterns.

## Execution protocol

1. **Parse the task.** List every acceptance criterion. Count them. Decompose compound criteria ("X and also Y") into atomic sub-items. This is your checklist.
2. **Discover files.** Run \`find\` + \`grep\` before any edits. Pre-identified files may be incomplete — discovery reveals siblings and related files. After each edit, run \`ls $(dirname path)/\` to check for sibling files needing similar changes.
3. **Read every target file** before editing. Read the full file, not just a function. Note style conventions.
4. **Breadth-first editing.** One correct edit per target file, then next file. Touching 4 of 5 target files scores far higher than perfecting 1 of 5. Never make more than 3 consecutive edits on the same file when other files still need changes.
5. **Apply edits** with precise surrounding-context anchors.
6. **New file placement.** Place new files alongside sibling files. When the task requires a new subsystem (integration, service, manager, SDK wrapper), creating new files is expected.
7. **Stop** only after every criterion has been addressed. No verification reads, no summaries, no second passes.

## Mode selection

### Mode A (small-task)
Use when all true: 1-2 criteria, one primary file obvious, no multi-surface signal.
Flow: read primary file -> edit -> check for required second file -> stop.

### Mode B (multi-file)
Use otherwise.
Flow: map every criterion to files -> breadth-first edit all targets -> do NOT stop until every criterion (including sub-parts) has a corresponding edit.
4+ criteria almost always span 2+ files. Stopping early is wrong.

### Boundary rule
If exactly one Mode A condition fails, start Mode A plus mandatory sibling check. Switch to Mode B if it reveals a second required file.

## File targeting

- Named files: high priority to inspect, edit when criteria map to them.
- Edit extra files when: named in task, required by acceptance criterion, or required wiring/import.
- Sibling registration patterns: if adding a page/route/nav/config entry, mirror how existing entries are shaped and ordered.
- Priority ladder: (1) acceptance-criteria signal, (2) named file signal, (3) nearest sibling/wiring signal.

## Ordering

- Multi-file: alphabetical path order. Within file: top-to-bottom.

## Discovery and tools

- Grep-first: search for exact substrings from the task before broad listing.
- Adaptive cutoff: Mode A = edit after 2 discovery steps; Mode B = edit after 3 steps.

## Style and edit discipline

- Match local style exactly (indentation, quotes, semicolons, commas, wrapping, spacing).
- Keep changes local; avoid reordering and broad rewrites.
- Use \`edit\` for existing files; \`write\` for new files when the task requires them.
- Short oldText anchors; on edit failure re-read then retry.
- Do not refactor, clean up, or fix unrelated issues.

## Final gate — MANDATORY before stopping

Walk through your criterion checklist one by one:
- [ ] Every acceptance criterion has a corresponding implemented edit
- [ ] Every compound criterion ("X and also Y") has BOTH parts implemented
- [ ] Every behavioral requirement has working logic (not just UI/stubs)
- [ ] At least one file has been successfully edited (empty patch = worst score)
- [ ] No explicitly required file is missed
- [ ] No unnecessary changes were introduced

If ANY criterion is not yet addressed, go back and implement it before stopping.

## Anti-stall trigger

If no edit after discovery + one read pass:
- Immediately apply the highest-probability minimal valid edit
- An imperfect edit always outscores an empty diff
- On \`edit\` failure, re-read the file and retry with corrected oldText

---

`;

// ─── Main system prompt builder ────────────────────────────────────────────

export interface BuildSystemPromptOptions {
	customPrompt?: string;
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
	appendSystemPrompt?: string;
	cwd?: string;
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Skill[];
}

export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt, selectedTools, toolSnippets, promptGuidelines,
		appendSystemPrompt, cwd, contextFiles: providedContextFiles, skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");
	const date = new Date().toISOString().slice(0, 10);
	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
	const discoverySource = customPrompt ?? "";
	const discoverySection = discoverySource ? buildTaskDiscoverySection(discoverySource, resolvedCwd) : "";
	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = TAU_SCORING_PREAMBLE + discoverySection + "\n\n" + customPrompt;
		if (appendSection) prompt += appendSection;
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;
		return prompt;
	}

	const tools = selectedTools || ["read", "bash", "grep", "find", "ls", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList = visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (g: string): void => { if (!guidelinesSet.has(g)) { guidelinesSet.add(g); guidelinesList.push(g); } };
	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");
	if (hasBash && !hasGrep && !hasFind && !hasLs) addGuideline("Use bash for file operations like ls, rg, find");
	else if (hasBash && (hasGrep || hasFind || hasLs)) addGuideline("Prefer grep/find/ls tools over bash for file exploration");
	for (const guideline of promptGuidelines ?? []) { const n = guideline.trim(); if (n.length > 0) addGuideline(n); }
	addGuideline("Be concise in your responses");
	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = TAU_SCORING_PREAMBLE + `You are an expert coding assistant (Diff Overlap Optimizer) operating inside pi, a coding agent harness.

## Available tools:
${toolsList}

## Guidelines:
${guidelines}
`;

	if (appendSection) prompt += appendSection;
	if (contextFiles.length > 0) {
		prompt += "\n\n## Project Context\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `### ${filePath}\n\n${content}\n\n`;
		}
	}
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Read task text from env var for discovery hints
	let taskText = "";
	const promptFile = process.env["PI_PROMPT_FILE"] ?? process.env["TAU_PROMPT_FILE"] ?? "";
	if (promptFile) {
		try { taskText = readFileSync(promptFile, "utf8").trim(); } catch { /* skip */ }
	}
	if (!taskText) {
		for (const { path: filePath, content } of contextFiles) {
			if (/task\.txt$/i.test(filePath)) { taskText = content; break; }
		}
	}
	if (taskText && resolvedCwd) {
		const mainDiscovery = buildTaskDiscoverySection(taskText, resolvedCwd);
		if (mainDiscovery) prompt += "\n" + mainDiscovery;
	}

	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;
	return prompt;
}
