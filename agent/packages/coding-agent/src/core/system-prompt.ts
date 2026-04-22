/**
 * Tierra-v37 — Lean discovery, 3s budget, no O(n×m) verification
 *
 * Root cause fix for 48% zero-output in duel #3620:
 * v36 grepForKeywords had O(keywords × files) verification loop (1200+ execSync calls).
 * v37 uses king's approach: per-keyword grep with small limits, aggregate by file count.
 * Removed: findByFilename (nexus-v3 doesn't have it, scores 0.220).
 * Budget: 3000ms hard cap (was 8000ms).
 * Max files: 5 (was 8).
 *
 * Build: 2026-04-22 by Claude Opus for T68Bot
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

// ─── Constants ─────────────────────────────────────────────────────────────

const BUDGET_MS = 3000; // Hard cap for ALL discovery. Was 8000 in v36, 10000 in v35.

const EXCLUDED_FILE_PATTERNS = /package-lock|yarn\.lock|pnpm-lock|\.d\.ts$|\.min\.(js|css)$|\.map$|generated|__generated__|\.snap$|\.svg$|CHANGELOG|LICENSE/i;

const STOP_WORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "could",
	"should", "may", "might", "must", "shall", "can", "need", "dare",
	"to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
	"into", "through", "during", "before", "after", "above", "below",
	"between", "out", "off", "over", "under", "again", "further", "then",
	"once", "here", "there", "when", "where", "why", "how", "all", "each",
	"every", "both", "few", "more", "most", "other", "some", "such", "no",
	"nor", "not", "only", "own", "same", "so", "than", "too", "very",
	"and", "but", "or", "if", "while", "because", "until", "that", "this",
	"it", "its", "he", "she", "they", "we", "you", "my", "your", "his",
	"her", "our", "their", "what", "which", "who", "whom",
	"add", "remove", "update", "change", "fix", "create", "delete", "modify",
	"implement", "make", "ensure", "also", "new", "file", "code", "function",
]);

const INCLUDE_ARGS = '--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" --include="*.py" --include="*.css" --include="*.scss" --include="*.json" --include="*.html" --include="*.vue" --include="*.svelte" --include="*.go" --include="*.rs" --include="*.java" --include="*.kt" --include="*.swift" --include="*.dart" --include="*.php" --include="*.rb" --include="*.cs" --include="*.cpp" --include="*.c" --include="*.h" --include="*.hpp" --include="*.sql" --include="*.yaml" --include="*.yml" --include="*.toml" --include="*.md"';

const EXCLUDE_DIRS = "grep -v node_modules | grep -v '/\\.git/' | grep -v '/dist/' | grep -v '/build/' | grep -v '/\\.next/' | grep -v '/target/' | grep -v '/out/'";

// ─── Utility ───────────────────────────────────────────────────────────────

function shellEscape(s: string): string {
	return s.replace(/'/g, "'\\''");
}

// ─── Keyword extraction ────────────────────────────────────────────────────

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
	deduped.sort((a, b) => {
		const aIsPath = a.includes("/") || (a.includes(".") && a.length > 4);
		const bIsPath = b.includes("/") || (b.includes(".") && b.length > 4);
		if (aIsPath && !bIsPath) return -1;
		if (!aIsPath && bIsPath) return 1;
		return b.length - a.length;
	});
	return deduped.slice(0, 12);
}

// ─── Content grep (king's approach: per-keyword, no cross-verification) ────

function grepForKeywords(keywords: string[], cwd: string, budgetEnd: number): Map<string, number> {
	const fileHitCount = new Map<string, number>();

	for (const kw of keywords) {
		if (Date.now() >= budgetEnd) break;
		const safeKw = shellEscape(kw);
		try {
			const cmd = `timeout 1.5 grep -rlF '${safeKw}' ${INCLUDE_ARGS} . 2>/dev/null | ${EXCLUDE_DIRS} | head -15`;
			const output = execSync(cmd, { cwd, encoding: "utf-8", timeout: 2000, maxBuffer: 64 * 1024 }).trim();
			if (output) {
				for (const line of output.split("\n")) {
					const file = line.trim().replace(/^\.\//, "");
					if (!file || EXCLUDED_FILE_PATTERNS.test(file)) continue;
					fileHitCount.set(file, (fileHitCount.get(file) ?? 0) + 1);
				}
			}
		} catch { continue; }
	}

	return fileHitCount;
}

// ─── Style detection ───────────────────────────────────────────────────────

interface CodeStyle { indent: string; quotes: string; semicolons: boolean; trailingCommas: boolean; }

function detectStyle(filePaths: string[], cwd: string): CodeStyle | null {
	const samples: string[] = [];
	for (const fp of filePaths.slice(0, 2)) {
		try {
			const full = resolve(cwd, fp);
			if (!existsSync(full)) continue;
			const stat = statSync(full);
			if (!stat.isFile() || stat.size > 500_000) continue;
			samples.push(readFileSync(full, "utf8").split("\n").slice(0, 60).join("\n"));
		} catch { continue; }
	}
	if (samples.length === 0) return null;

	const allText = samples.join("\n");
	const lines = allText.split("\n").filter((l) => l.length > 0);

	let tab = 0, space2 = 0, space4 = 0;
	for (const line of lines) {
		if (line.startsWith("\t")) tab++;
		else if (line.startsWith("  ") && !line.startsWith("    ")) space2++;
		else if (line.startsWith("    ")) space4++;
	}
	const indent = tab > space2 + space4 ? "tabs" : space4 > space2 ? "4 spaces" : "2 spaces";

	const singleQuotes = (allText.match(/'/g) ?? []).length;
	const doubleQuotes = (allText.match(/"/g) ?? []).length;
	const quotes = singleQuotes > doubleQuotes * 1.5 ? "single" : doubleQuotes > singleQuotes * 1.5 ? "double" : "mixed";

	const statementsWithSemi = (allText.match(/;\s*$/gm) ?? []).length;
	const statementsTotal = lines.filter((l) => l.trim().length > 0 && !l.trim().startsWith("//") && !l.trim().startsWith("*")).length;
	const semicolons = statementsTotal > 0 ? statementsWithSemi / statementsTotal > 0.3 : true;

	const trailingCommaMatches = (allText.match(/,\s*[\n\r]\s*[}\]\)]/g) ?? []).length;
	const closingBrackets = (allText.match(/[}\]\)]/g) ?? []).length;
	const trailingCommas = closingBrackets > 0 ? trailingCommaMatches / closingBrackets > 0.2 : false;

	return { indent, quotes, semicolons, trailingCommas };
}

// ─── Criteria counter ──────────────────────────────────────────────────────

function countCriteria(taskText: string): number {
	let count = 0;
	const section = taskText.match(
		/(?:acceptance\s+criteria|requirements|tasks?|todo):?\s*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|\n(?=##)|$)/i,
	);
	if (section) {
		const bullets = section[1].match(/^\s*(?:[-*•+]|\d+[.)]\s)/gm);
		if (bullets) return Math.min(bullets.length, 20);
	}
	const bullets = taskText.match(/^[\s]*[-*•]\s+/gm);
	if (bullets) count += bullets.length;
	const numbered = taskText.match(/^\s*\d+[.)\]]\s+/gm);
	if (numbered) count += numbered.length;
	const sentences = taskText.split(/[.!]\s+/);
	for (const s of sentences) {
		if (/^(add|create|implement|update|modify|change|fix|remove|delete|ensure|make|move|rename|refactor|replace|set|configure|enable|disable|show|hide|display|handle|validate|check|integrate|convert|extract|migrate|wrap|export|import|register|connect|extend|override|support|allow|prevent|include)\b/i.test(s.trim())) {
			count++;
		}
	}
	const andMatches = taskText.match(/\b(?:and also|and then|, and\s)/gi);
	if (andMatches) count += andMatches.length;
	return Math.max(Math.ceil(count * 0.75), 1);
}

// ─── Main discovery builder ────────────────────────────────────────────────

function buildTaskDiscoverySection(taskText: string, cwd: string): string {
	if (!taskText || taskText.trim().length < 10) return "";

	const budgetEnd = Date.now() + BUDGET_MS;

	try {
		const keywords = extractKeywords(taskText);
		if (keywords.length === 0) return "";

		// Per-keyword grep — no O(n×m) verification loop
		const fileHitCount = grepForKeywords(keywords, cwd, budgetEnd);
		if (fileHitCount.size === 0) return "";

		// Rank by hit count, take top 5
		const ranked = [...fileHitCount.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 15);

		// Literal paths from task text
		const literalPaths: string[] = [];
		const backtickPaths = taskText.match(/`([^`]+\.[a-zA-Z0-9]{1,6})`/g) || [];
		for (const b of backtickPaths) {
			const inner = b.slice(1, -1).trim().replace(/^\.\//, "");
			try {
				const full = resolve(cwd, inner);
				if (existsSync(full) && statSync(full).isFile()) literalPaths.push(inner);
			} catch { /* skip */ }
		}
		const pathRegex = /(?:^|[\s"'`(\[])((?:\.\.?\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?=$|[\s"'`)\],:;.])/g;
		let match;
		while ((match = pathRegex.exec(taskText)) !== null) {
			const cleaned = match[1].trim().replace(/^\.\//, "");
			if (literalPaths.includes(cleaned)) continue;
			try {
				const full = resolve(cwd, cleaned);
				if (existsSync(full) && statSync(full).isFile()) literalPaths.push(cleaned);
			} catch { /* skip */ }
		}

		const criteriaCount = countCriteria(taskText);

		// Concentration detection
		const top = ranked[0];
		const second = ranked[1];
		const concentrated = top && top[1] >= 3 && (!second || top[1] >= second[1] * 2);

		// Style detection (only if budget remains)
		const topPath = literalPaths[0] || ranked[0]?.[0];
		let style: CodeStyle | null = null;
		if (topPath && Date.now() < budgetEnd) {
			style = detectStyle([topPath], cwd);
		}

		// ── Format output ──
		const sections: string[] = [];

		sections.push(`~${criteriaCount} criteria. Budget at least ${Math.max(criteriaCount, 1)} file edits.`);

		if (concentrated && top) {
			sections.push(`\nKEYWORD CONCENTRATION: \`${top[0]}\` matches ${top[1]} task keywords — read it first, apply ALL related edits there.`);
		}

		if (literalPaths.length > 0) {
			sections.push("\nFILES NAMED IN TASK:");
			for (const p of literalPaths) sections.push(`- ${p}`);
		}

		const shownPaths = new Set(literalPaths);
		const contentRanked = ranked.filter(([path]) => !shownPaths.has(path)).slice(0, 5);
		if (contentRanked.length > 0) {
			contentRanked.sort((a, b) => a[0].localeCompare(b[0]));
			sections.push("\nSTART HERE:");
			for (const [path] of contentRanked) sections.push(`- ${path}`);
		}

		if (style) {
			sections.push(`\nStyle: ${style.indent}, ${style.quotes} quotes, ${style.semicolons ? "semicolons" : "no semicolons"}, ${style.trailingCommas ? "trailing commas" : "no trailing commas"}.`);
		}

		return "\n\n## Task Discovery\n\n" + sections.join("\n") + "\n";
	} catch { return ""; }
}

// ─── Scoring Preamble ──────────────────────────────────────────────────────

const TAU_SCORING_PREAMBLE = `# Surgical Diff Optimizer

Your diff is scored against a hidden reference diff for the same task.
Overlap scoring rewards matching changed lines/ordering and penalizes surplus edits.
No semantic bonus. No tests in scoring.
**Empty patches score worst** — treat a non-empty diff as a first-class objective.

## Hard constraints

- Start with a tool call immediately.
- No tests, builds, linters, formatters, servers, or git operations.
- No package installs unless the task explicitly names a dependency.
- Read a file before editing it.
- Implement only what is explicitly requested — but implement ALL of it.
- If instructions conflict: explicit task requirements > hard constraints > smallest edit set.
- **Non-empty patch:** finish with at least one successful \`edit\` or \`write\`. If blocked, report the blocker.
- Literality: choose the most boring continuation of nearby code patterns.

## Two loss modes

- **Surplus** — extra lines inflate denominator. Fewer changed lines wins.
- **Misalignment** — missing a file/criterion the reference changed = all its lines lost.

## Mode selection

### Mode A (small-task)
1-2 criteria, one primary file obvious.
Flow: read → edit → check for required second file → stop.

### Mode B (multi-file)
Otherwise. Flow: map every criterion to files → breadth-first edit all → do NOT stop until every criterion has an edit.

### Mode C (concentrated)
KEYWORD CONCENTRATION shows one dominant file.
Flow: read that file → apply all edits top-to-bottom → then check other files.

## Acceptance Criteria Discipline

- Count the criteria. Each typically needs at least one edit.
- If the task names multiple files, touch each named file.
- "X and also Y" means both halves need edits.
- 4+ criteria almost always span 2+ files. Stopping early is wrong.

## File targeting

- Named files: inspect first, edit when criteria map to them.
- New file placement: alongside sibling files at the path given in the task.
- Priority: (1) acceptance-criteria signal, (2) named file, (3) sibling/wiring signal.

## Edit discipline

- Match local style exactly (indent, quotes, semicolons, commas, wrapping).
- Short \`oldText\` anchors from current \`read\`. On failure: **re-read** then retry — never from memory.
- \`edit\` for existing files; \`write\` only for explicitly requested new files.
- Do not refactor, clean up, or fix unrelated issues.
- Exact strings from task → character-for-character in edits.
- Alphabetical file path order. Within file: top-to-bottom.

## Final gate

Walk criterion checklist:
- Every acceptance criterion has a corresponding edit
- Compound criteria ("X and also Y") have BOTH parts
- At least one file successfully edited
- No required file missed; no unnecessary changes
If any criterion unaddressed → go back and implement before stopping.

## Anti-stall

No edit after discovery + one read → immediately apply highest-probability edit.
On \`edit\` failure → re-read and retry. Never repeat \`oldText\` from memory.
**An imperfect edit always outscores empty diff.**

8. **Stop.** No verification reads, no summaries, no second passes.

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

	let prompt = `You are an expert coding assistant (Surgical Diff Optimizer).
Your diff is scored against a hidden reference diff. Overlap scoring rewards matching changed lines and penalizes surplus.
**Empty patches score worst** — treat a non-empty diff as a first-class objective.

## Available tools:
${toolsList}

## Guidelines:
${guidelines}
`;
	prompt += TAU_SCORING_PREAMBLE;
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

	// Inject discovery from task text env var if available
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
