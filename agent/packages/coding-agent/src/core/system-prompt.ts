/**
 * Tierra-v35 — System prompt with unified scoring preamble + 3-phase discovery
 *
 * Changes from v34:
 * - Merged two preamble constants into ONE TAU_SCORING_PREAMBLE (~80 lines vs ~260)
 * - Discovery output capped at 8 files (was 10), sorted alphabetically
 * - Added DISCOVERY ORDER directive from nexus-v3
 * - Kept all Phase 1/2/3 discovery, filename grep, concentration, style detection
 * - Kept detectConcentration matchCount sort fix
 *
 * Build: 2026-04-22 by Claude Opus for T68Bot
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

// ─── Phase 2: Known patterns from 2,085 real SN66 winning diffs ───────────
const KNOWN_PATTERNS: Record<string, string[]> = {
	component: ["src/components", "frontend/src", "src/app", "apps/web"],
	api: ["src/routes", "src/api", "packages", "apps"],
	route: ["src/routes", "src/pages", "src/app", "apps"],
	test: ["src/__tests__", "tests", "src/test", "packages"],
	database: ["src/db", "src/models", "src/repositories", "prisma"],
	config: ["src/config", "config", "src/settings"],
	hook: ["src/hooks", "frontend/src/hooks"],
	service: ["src/services", "src/lib", "src/utils"],
	migration: ["migrations", "db/migrations", "prisma/migrations"],
	style: ["src/styles", "src/css", "styles"],
	middleware: ["src/middleware", "src/middlewares", "middleware"],
	handler: ["src/handlers", "src/controllers", "handlers"],
	package: ["cmd", "internal", "pkg", "api"],
	func: ["cmd", "internal", "pkg", "handlers", "services"],
	model: ["models", "internal/models", "pkg/models", "src/models"],
	controller: ["src/main/java", "src/main/kotlin", "src/controllers"],
	repository: ["src/main/java", "src/repositories", "repositories"],
};

// ─── Phase 3: Validated patterns from 32B fine-tuned model ────────────────
const VALIDATED_32B_PATTERNS: Record<string, string[]> = {
	component: ["src/components", "src/app", "frontend/src", "src/pages", "app/components", "landing/src", "app/src"],
	api_route: ["src/app/api", "src/routes", "pages/api", "app/api", "server/routes", "apps/developer-portal-api", "backend/src"],
	service: ["src/main", "src/services", "internal/services", "packages/core", "apps/developer-portal-api"],
	service_java: ["src/main/java", "src/main/kotlin", "src/test"],
	go_packages: ["packages/typespec-go", "packages/autorest.go", "cmd", "internal", "pkg"],
	go_internal: ["internal", "internal/handlers", "internal/services", "internal/models"],
	migration: ["database/migrations", "migrations", "db/migrations", "prisma/migrations", "supabase/functions"],
	config: ["src/config", "config", "src/main", ".env", "src/app"],
	serverless: ["supabase/functions", "app/api", "pages/api"],
	auth: ["src/pages", "src/app", "frontend/src", "apps/developer-portal-api", "src/main"],
	test: ["src/test", "tests/api_contracts", "src/main", "test"],
	hook: ["supabase/functions", "src/components", "src/hooks", "lib/hooks", "src/app"],
	style: ["src/components", "landing/src", "src/app", "public", "src/styles"],
	form: ["src/components", "src/pages", "frontend/src", "supabase/functions", "src/app"],
	middleware: ["src/Infrastructure", "backends/go-gin", "backends/python-fastapi", "server", "src/middleware"],
	monorepo: ["packages/core", "apps/web", "apps/developer-portal", "libs"],
};

// ─── Excluded file patterns ──────────────────────────────────────────────
const EXCLUDED_FILE_PATTERNS = /package-lock|yarn\.lock|pnpm-lock|\.d\.ts$|\.min\.(js|css)$|\.map$|generated|__generated__|\.snap$|\.svg$|CHANGELOG|LICENSE/i;

// ─── Stop words for keyword extraction ────────────────────────────────────
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

// ─── Exclude dirs for grep ────────────────────────────────────────────────
const EXCLUDE_DIRS = [
	"node_modules", ".git", "dist", "build", ".next", "__pycache__",
	".cache", "coverage", ".tox", "vendor", "target", ".svn",
	"bower_components", ".gradle", ".idea", ".vscode", "out",
];

const INCLUDE_EXTS = [
	"*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.py", "*.css", "*.scss",
	"*.json", "*.html", "*.vue", "*.svelte", "*.go", "*.rs",
	"*.java", "*.kt", "*.swift", "*.dart", "*.php", "*.rb",
	"*.cs", "*.cpp", "*.c", "*.h", "*.hpp", "*.sql", "*.yaml", "*.yml", "*.toml", "*.md",
];

// ─── Interfaces ───────────────────────────────────────────────────────────
interface FileMatch {
	path: string;
	matchedKeywords: string[];
	matchCount: number;
	score: number;
	filenameMatch?: boolean;
}

interface CodeStyle {
	indent: string;
	quotes: string;
	semicolons: boolean;
	trailingCommas: boolean;
}

interface ConcentrationResult {
	concentrated: boolean;
	primaryFile: string | null;
	primaryCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════════════════

function shellEscape(s: string): string {
	return s.replace(/'/g, "'\\''");
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: Core keyword extraction and grep discovery
// ═══════════════════════════════════════════════════════════════════════════

function extractKeywords(taskText: string): string[] {
	const keywords = new Set<string>();

	// Backtick-quoted identifiers (highest priority)
	const backtickMatches = taskText.match(/`([^`]+)`/g);
	if (backtickMatches) {
		for (const m of backtickMatches) {
			const inner = m.slice(1, -1).trim();
			if (inner.length >= 2 && inner.length <= 80) keywords.add(inner);
		}
	}

	// camelCase
	const camelMatches = taskText.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g);
	if (camelMatches) for (const m of camelMatches) keywords.add(m);

	// PascalCase
	const pascalMatches = taskText.match(/\b[A-Z][a-z]+[A-Z][a-zA-Z0-9]*\b/g);
	if (pascalMatches) for (const m of pascalMatches) keywords.add(m);

	// snake_case
	const snakeMatches = taskText.match(/\b[a-z][a-z0-9]*_[a-z][a-z0-9_]*\b/g);
	if (snakeMatches) for (const m of snakeMatches) keywords.add(m);

	// kebab-case
	const kebabMatches = taskText.match(/\b[a-z][a-z0-9]*-[a-z][a-z0-9-]*\b/g);
	if (kebabMatches) for (const m of kebabMatches) keywords.add(m);

	// SCREAMING_SNAKE_CASE
	const screamingMatches = taskText.match(/\b[A-Z][A-Z0-9]*_[A-Z][A-Z0-9_]*\b/g);
	if (screamingMatches) for (const m of screamingMatches) keywords.add(m);

	// File paths (contain /)
	const pathMatches = taskText.match(/(?:[\w.-]+\/)+[\w.-]+/g);
	if (pathMatches) for (const m of pathMatches) keywords.add(m);

	// File extensions (known source extensions)
	const extMatches = taskText.match(/\b[\w-]+\.\w{1,6}\b/g);
	if (extMatches) {
		for (const m of extMatches) {
			if (/\.(ts|tsx|js|jsx|py|css|json|html|vue|svelte|go|rs|java|kt|swift|dart|php|rb|cs|cpp|h|sql|yaml|yml|md|sh|toml)$/i.test(m)) {
				keywords.add(m);
			}
		}
	}

	// Filter stop words, short keywords, deduplicate
	const result: string[] = [];
	for (const kw of keywords) {
		if (kw.length >= 3 && !STOP_WORDS.has(kw.toLowerCase())) {
			result.push(kw);
		}
	}
	const deduped = [...new Set(result)];
	// Prioritize file paths and long identifiers, cap at 15
	deduped.sort((a, b) => {
		const aIsPath = a.includes("/") || (a.includes(".") && a.length > 4);
		const bIsPath = b.includes("/") || (b.includes(".") && b.length > 4);
		if (aIsPath && !bIsPath) return -1;
		if (!aIsPath && bIsPath) return 1;
		return b.length - a.length;
	});
	return deduped.slice(0, 15);
}

function extractNamedFiles(taskText: string): string[] {
	const matches = taskText.match(/`([^`]+\.[a-zA-Z0-9]{1,6})`/g) || [];
	return [...new Set(matches.map((f) => f.replace(/`/g, "").trim()))];
}

function grepForKeywords(keywords: string[], cwd: string): Map<string, Set<string>> {
	const fileHits = new Map<string, Set<string>>();
	const includeArgs = INCLUDE_EXTS.map((e) => `--include="${e}"`).join(" ");

	if (keywords.length === 0) return fileHits;

	// Batch grep: find all files matching ANY keyword
	const kwArgs = keywords.map((kw) => `-e '${shellEscape(kw)}'`).join(" ");
	try {
		const cmd = `timeout 5 grep -rlF ${kwArgs} ${includeArgs} . 2>/dev/null | grep -v node_modules | grep -v '/\\.git/' | grep -v '/dist/' | grep -v '/build/' | grep -v '/\\.next/' | grep -v '/target/' | head -80`;
		const output = execSync(cmd, {
			cwd,
			encoding: "utf-8",
			timeout: 7000,
			maxBuffer: 1024 * 128,
		}).trim();

		if (output) {
			const candidateFiles = output.split("\n").map((f) => f.replace(/^\.\//, ""));

			// Per-keyword grep on candidate files only
			for (const keyword of keywords) {
				const safeKw = shellEscape(keyword);
				for (const filePath of candidateFiles) {
					const safePath = shellEscape(filePath);
					try {
						execSync(`grep -qF '${safeKw}' '${safePath}' 2>/dev/null`, {
							cwd,
							encoding: "utf-8",
							timeout: 1000,
						});
						if (!fileHits.has(filePath)) fileHits.set(filePath, new Set());
						fileHits.get(filePath)!.add(keyword);
					} catch {
						// No match
					}
				}
			}
		}
	} catch {
		// Batch grep failed — fall back to per-keyword
		for (const keyword of keywords.slice(0, 10)) {
			const safeKw = shellEscape(keyword);
			try {
				const cmd = `timeout 2 grep -rlF '${safeKw}' ${includeArgs} . 2>/dev/null | grep -v node_modules | grep -v '/\\.git/' | grep -v '/dist/' | grep -v '/build/' | grep -v '/\\.next/' | head -30`;
				const output = execSync(cmd, {
					cwd,
					encoding: "utf-8",
					timeout: 3000,
					maxBuffer: 1024 * 64,
				}).trim();

				if (output) {
					for (const fp of output.split("\n")) {
						const normalized = fp.replace(/^\.\//, "");
						if (!fileHits.has(normalized)) fileHits.set(normalized, new Set());
						fileHits.get(normalized)!.add(keyword);
					}
				}
			} catch {
				continue;
			}
		}
	}

	return fileHits;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1b: Filename grep — catches files where keyword is in the filename
// but not content yet (new files, config files, etc.)
// ═══════════════════════════════════════════════════════════════════════════

function findByFilename(keywords: string[], cwd: string): Map<string, Set<string>> {
	const fileHits = new Map<string, Set<string>>();

	for (const kw of keywords.slice(0, 10)) {
		if (kw.includes("/") || kw.includes(" ") || kw.length > 40) continue;

		try {
			const safeKw = shellEscape(kw);
			const cmd = `find . -type f -iname "*${safeKw}*" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/.next/*" -not -path "*/target/*" 2>/dev/null | head -10`;
			const output = execSync(cmd, {
				cwd,
				encoding: "utf-8",
				timeout: 2000,
				maxBuffer: 1024 * 64,
			}).trim();

			if (output) {
				for (const line of output.split("\n")) {
					const file = line.trim().replace(/^\.\//, "");
					if (!file || EXCLUDED_FILE_PATTERNS.test(file)) continue;
					if (!fileHits.has(file)) fileHits.set(file, new Set());
					fileHits.get(file)!.add(kw);
				}
			}
		} catch {
			continue;
		}
	}

	return fileHits;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Enhanced discovery — patterns, siblings, templates
// ═══════════════════════════════════════════════════════════════════════════

function findSiblings(filePath: string, cwd: string): string[] {
	const siblings: string[] = [];
	const dir = filePath.substring(0, filePath.lastIndexOf("/"));
	const baseName = filePath.substring(filePath.lastIndexOf("/") + 1).replace(/\.\w+$/, "");

	if (!dir) return siblings;

	const siblingPatterns = [
		`${dir}/index.ts`, `${dir}/index.tsx`,
		`${dir}/${baseName}.test.ts`, `${dir}/${baseName}.test.tsx`,
		`${dir}/${baseName}.spec.ts`, `${dir}/${baseName}.spec.tsx`,
		`${dir}/${baseName}.module.css`, `${dir}/${baseName}.module.scss`,
		`${dir}/${baseName}.styles.ts`, `${dir}/${baseName}.styles.tsx`,
	];

	try {
		const cmd = `ls ${siblingPatterns.map((p) => `'${shellEscape(p)}'`).join(" ")} 2>/dev/null`;
		const output = execSync(cmd, { cwd, encoding: "utf-8", timeout: 2000, maxBuffer: 1024 * 16 }).trim();

		if (output) {
			for (const s of output.split("\n")) {
				const normalized = s.replace(/^\.\//, "");
				if (normalized && normalized !== filePath) siblings.push(normalized);
			}
		}
	} catch { /* No siblings */ }

	return siblings;
}

function searchKnownPatterns(taskText: string, cwd: string): Map<string, number> {
	const bonusFiles = new Map<string, number>();
	const taskLower = taskText.toLowerCase();

	for (const [keyword, dirs] of Object.entries(KNOWN_PATTERNS)) {
		if (!taskLower.includes(keyword)) continue;

		for (const dir of dirs) {
			try {
				const cmd = `find '${shellEscape(dir)}' -maxdepth 3 -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.py' -o -name '*.go' -o -name '*.java' -o -name '*.php' \\) 2>/dev/null | head -15`;
				const output = execSync(cmd, { cwd, encoding: "utf-8", timeout: 2000, maxBuffer: 1024 * 32 }).trim();

				if (output) {
					for (const fp of output.split("\n")) {
						const normalized = fp.replace(/^\.\//, "");
						bonusFiles.set(normalized, (bonusFiles.get(normalized) ?? 0) + 3);
					}
				}
			} catch { continue; }
		}
	}

	return bonusFiles;
}

function findTemplates(taskText: string, cwd: string): string[] {
	const templates: string[] = [];

	const addMatch = taskText.match(
		/(?:add|create|implement|build)\s+(?:a\s+)?(?:new\s+)?(\w+)\s+(component|route|page|middleware|service|hook|handler|controller)/i,
	);
	if (!addMatch) return templates;

	const type = addMatch[2].toLowerCase();
	const typeExtMap: Record<string, string> = {
		component: "*.tsx", route: "*.ts", page: "*.tsx", middleware: "*.ts",
		service: "*.ts", hook: "*.ts", handler: "*.ts", controller: "*.ts",
	};
	const ext = typeExtMap[type] ?? "*.ts";
	const patternDirs = KNOWN_PATTERNS[type] ?? KNOWN_PATTERNS["service"] ?? ["src"];

	for (const dir of patternDirs.slice(0, 3)) {
		try {
			const cmd = `find '${shellEscape(dir)}' -maxdepth 3 -name '${ext}' -type f 2>/dev/null | head -5`;
			const output = execSync(cmd, { cwd, encoding: "utf-8", timeout: 2000, maxBuffer: 1024 * 16 }).trim();

			if (output) {
				for (const fp of output.split("\n")) {
					const normalized = fp.replace(/^\.\//, "");
					if (normalized) templates.push(normalized);
				}
			}
		} catch { continue; }
	}

	return templates.slice(0, 5);
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: 32B-validated pattern boosting
// ═══════════════════════════════════════════════════════════════════════════

function apply32BBoost(taskText: string, fileScores: Map<string, number>): void {
	const taskLower = taskText.toLowerCase();

	const PATTERN_MATCHERS: Record<string, RegExp> = {
		component: /component|button|modal|dialog|page|layout|card|sidebar|header|footer|nav|spinner|loading|widget|panel|drawer/i,
		api_route: /api|route|endpoint|rest|graphql|handler|controller/i,
		service: /service|repository|provider|manager|layer|business.?logic/i,
		service_java: /java|spring|kotlin|bean|repository|jpa|hibernate/i,
		go_packages: /\.go\b|func\s|package\s|goroutine|interface\s|struct\s|go\s+mod/i,
		go_internal: /internal|handler|server\.go|main\.go/i,
		migration: /migration|database|table|column|schema|prisma|alembic|knex/i,
		config: /config|configuration|setting|env|environment|redis|cach/i,
		serverless: /supabase|serverless|edge.?function|lambda|cloud.?function/i,
		auth: /auth|login|signup|register|password|token|session|oauth|jwt|permission/i,
		test: /test|spec|jest|vitest|pytest|mocha|cypress|playwright|e2e|unit.?test/i,
		hook: /hook|useffect|usestate|use[A-Z]|lifecycle|supabase.?function/i,
		style: /style|css|scss|sass|tailwind|theme|design.?token|color|font|spacing/i,
		form: /form|input|select|checkbox|radio|validation|submit|field|textarea/i,
		middleware: /middleware|interceptor|guard|pipe|filter|cors|rate.?limit/i,
		monorepo: /monorepo|workspace|package|lerna|turborepo|nx\s/i,
	};

	for (const [patternKey, dirs] of Object.entries(VALIDATED_32B_PATTERNS)) {
		const matcher = PATTERN_MATCHERS[patternKey];
		if (!matcher || !matcher.test(taskLower)) continue;

		for (const [filePath, currentScore] of fileScores) {
			for (const dir of dirs) {
				if (filePath.includes(dir)) {
					fileScores.set(filePath, currentScore + 3);
					break;
				}
			}
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// File ranking (Phase 1 grep + Phase 1b filename + Phase 2 + Phase 3)
// ═══════════════════════════════════════════════════════════════════════════

function rankFiles(
	grepHits: Map<string, Set<string>>,
	filenameHits: Map<string, Set<string>>,
	patternBonus: Map<string, number>,
	taskText: string,
): FileMatch[] {
	const fileScores = new Map<string, number>();
	const fileKeywords = new Map<string, string[]>();
	const filenameMatchSet = new Set<string>();

	// Phase 1: grep keyword match scoring
	for (const [path, kwSet] of grepHits) {
		let score = 0;
		for (const kw of kwSet) {
			score += kw.length >= 10 ? 15 : kw.length >= 6 ? 12 : 10;
		}
		fileScores.set(path, score);
		fileKeywords.set(path, [...kwSet]);
	}

	// Phase 1b: filename grep scoring (+6 per keyword — stronger than content)
	for (const [path, kwSet] of filenameHits) {
		const existing = fileScores.get(path) ?? 0;
		fileScores.set(path, existing + kwSet.size * 6);
		filenameMatchSet.add(path);
		if (!fileKeywords.has(path)) fileKeywords.set(path, []);
		for (const kw of kwSet) {
			const kws = fileKeywords.get(path)!;
			if (!kws.includes(kw)) kws.push(kw);
		}
	}

	// Phase 2: known pattern bonus
	for (const [path, bonus] of patternBonus) {
		fileScores.set(path, (fileScores.get(path) ?? 0) + bonus);
		if (!fileKeywords.has(path)) fileKeywords.set(path, ["[pattern]"]);
	}

	// Context-aware type bonus
	const taskLower = taskText.toLowerCase();
	for (const [path, score] of fileScores) {
		let bonus = 0;
		const ext = path.split(".").pop()?.toLowerCase() ?? "";

		if (/component|button|modal|dialog|form|page|layout|card|list|table|sidebar|header|footer|nav|spinner/i.test(taskLower)) {
			if (["tsx", "jsx", "vue", "svelte"].includes(ext)) bonus += 5;
		}
		if (/api|endpoint|route|handler|controller|middleware|service|resolver/i.test(taskLower)) {
			if (["ts", "py", "go", "rs", "java", "php", "rb"].includes(ext)) bonus += 5;
		}
		if (/config|env|setting|option|theme/i.test(taskLower)) {
			if (["json", "yaml", "yml", "toml"].includes(ext) || /config/i.test(path)) bonus += 5;
		}
		if (/style|css|theme|color|font|layout|margin|padding/i.test(taskLower)) {
			if (["css", "scss", "less", "sass"].includes(ext)) bonus += 5;
		}

		if (/src\/components\//i.test(path)) bonus += 3;
		if (/src\/app\//i.test(path)) bonus += 2;
		if (/src\/pages\//i.test(path)) bonus += 2;

		// Penalties
		if (/\.test\.|\.spec\.|__tests__|__mocks__/i.test(path)) bonus -= 8;
		if (EXCLUDED_FILE_PATTERNS.test(path)) bonus -= 20;
		if (path.split("/").length > 6) bonus -= 2;
		if (!/test|spec|jest|vitest|pytest/i.test(taskText) && /\.test\.|\.spec\.|__tests__|__mocks__|fixtures/i.test(path)) {
			bonus -= 12;
		}

		fileScores.set(path, score + bonus);
	}

	// Phase 3: 32B validated pattern boost
	apply32BBoost(taskText, fileScores);

	// Build results
	const results: FileMatch[] = [];
	for (const [path, score] of fileScores) {
		const kws = fileKeywords.get(path) ?? [];
		results.push({
			path,
			matchedKeywords: kws,
			matchCount: kws.length,
			score,
			filenameMatch: filenameMatchSet.has(path),
		});
	}

	// Sort by score for selection, keep top 15 for internal use
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, 15);
}

// ═══════════════════════════════════════════════════════════════════════════
// Keyword concentration detection
// ═══════════════════════════════════════════════════════════════════════════

function detectConcentration(ranked: FileMatch[]): ConcentrationResult {
	if (ranked.length === 0) return { concentrated: false, primaryFile: null, primaryCount: 0 };

	// Sort by matchCount (unique keyword count) — not by score which includes pattern boosts.
	const byMatchCount = [...ranked].sort((a, b) => b.matchCount - a.matchCount);
	const top = byMatchCount[0];
	const second = byMatchCount[1];
	const concentrated = top.matchCount >= 3 && (!second || top.matchCount >= second.matchCount * 2);
	return {
		concentrated,
		primaryFile: concentrated ? top.path : null,
		primaryCount: top.matchCount,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Style detection
// ═══════════════════════════════════════════════════════════════════════════

function detectStyle(filePaths: string[], cwd: string): CodeStyle | null {
	const samples: string[] = [];

	for (const fp of filePaths.slice(0, 3)) {
		try {
			const full = resolve(cwd, fp);
			if (!existsSync(full)) continue;
			const stat = statSync(full);
			if (!stat.isFile() || stat.size > 1_000_000) continue;
			const content = readFileSync(full, "utf8");
			samples.push(content.split("\n").slice(0, 100).join("\n"));
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
	const statementsTotal = lines.filter(
		(l) => l.trim().length > 0 && !l.trim().startsWith("//") && !l.trim().startsWith("*"),
	).length;
	const semicolons = statementsTotal > 0 ? statementsWithSemi / statementsTotal > 0.3 : true;

	const trailingCommaMatches = (allText.match(/,\s*[\n\r]\s*[}\]\)]/g) ?? []).length;
	const closingBrackets = (allText.match(/[}\]\)]/g) ?? []).length;
	const trailingCommas = closingBrackets > 0 ? trailingCommaMatches / closingBrackets > 0.2 : false;

	return { indent, quotes, semicolons, trailingCommas };
}

// ═══════════════════════════════════════════════════════════════════════════
// Acceptance criteria counter
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// Git diff awareness
// ═══════════════════════════════════════════════════════════════════════════

function getGitChangedFiles(cwd: string): string[] {
	try {
		let base = "";
		try {
			const branches = execSync("git branch -a 2>/dev/null", {
				cwd, encoding: "utf-8", timeout: 2000,
			});
			if (branches.includes("origin/main")) base = "origin/main";
			else if (branches.includes("origin/master")) base = "origin/master";
			else if (/\bmain\b/.test(branches)) base = "main";
			else if (/\bmaster\b/.test(branches)) base = "master";
		} catch { return []; }

		if (!base) return [];

		let currentBranch = "";
		try {
			currentBranch = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
				cwd, encoding: "utf-8", timeout: 2000,
			}).trim();
		} catch { return []; }

		if (currentBranch === base || currentBranch === base.replace("origin/", "")) return [];

		const output = execSync(
			`git diff --name-only ${base}...HEAD 2>/dev/null || git diff --name-only HEAD~1 2>/dev/null`,
			{ cwd, encoding: "utf-8", timeout: 3000, maxBuffer: 1024 * 32 },
		).trim();

		if (output) {
			return output.split("\n")
				.filter((f) => f.length > 0 && !EXCLUDED_FILE_PATTERNS.test(f))
				.slice(0, 20);
		}
	} catch { /* git not available */ }
	return [];
}

// ═══════════════════════════════════════════════════════════════════════════
// Main discovery function (all phases combined)
// ═══════════════════════════════════════════════════════════════════════════

function buildTaskDiscoverySection(taskText: string, cwd: string): string {
	if (!taskText || taskText.trim().length < 10) return "";

	const overallStart = Date.now();
	const BUDGET_MS = 10000;

	try {
		// Phase 1: Extract keywords and grep
		const keywords = extractKeywords(taskText);
		if (keywords.length === 0) return "";

		const grepHits = grepForKeywords(keywords, cwd);

		// Phase 1b: Filename grep
		let filenameHits = new Map<string, Set<string>>();
		if (Date.now() - overallStart < BUDGET_MS * 0.5) {
			filenameHits = findByFilename(keywords, cwd);
		}

		// Phase 2: Known pattern search
		let patternBonus = new Map<string, number>();
		if (Date.now() - overallStart < BUDGET_MS * 0.6) {
			patternBonus = searchKnownPatterns(taskText, cwd);
		}

		if (grepHits.size === 0 && filenameHits.size === 0 && patternBonus.size === 0) return "";

		// Combined ranking (Phase 1 + 1b + 2 + 3)
		const ranked = rankFiles(grepHits, filenameHits, patternBonus, taskText);
		if (ranked.length === 0) return "";

		// Phase 2b: Sibling detection
		const siblingFiles: string[] = [];
		if (Date.now() - overallStart < BUDGET_MS * 0.8) {
			for (const file of ranked.slice(0, 5)) {
				const siblings = findSiblings(file.path, cwd);
				for (const s of siblings) {
					if (!siblingFiles.includes(s) && !ranked.some((r) => r.path === s)) {
						siblingFiles.push(s);
					}
				}
			}
		}

		// Phase 2c: Template finder
		let templateFiles: string[] = [];
		if (Date.now() - overallStart < BUDGET_MS * 0.9) {
			templateFiles = findTemplates(taskText, cwd);
		}

		// Style detection
		const topPaths = ranked.slice(0, 3).map((f) => f.path);
		const style = detectStyle(topPaths, cwd);

		// Git diff awareness
		let gitChangedFiles: string[] = [];
		if (Date.now() - overallStart < BUDGET_MS * 0.95) {
			gitChangedFiles = getGitChangedFiles(cwd);
			for (const gf of gitChangedFiles) {
				const existing = ranked.find((r) => r.path === gf);
				if (existing) existing.score += 6;
			}
			ranked.sort((a, b) => b.score - a.score);
		}

		// Criteria count + concentration + mode selection
		const criteriaCount = countCriteria(taskText);
		const concentration = detectConcentration(ranked);
		const namedFiles = extractNamedFiles(taskText);

		// Check for literal file paths in task
		const literalPaths: string[] = [];
		const pathMatches = taskText.match(/(?:^|[\s"'`(\[])((?:\.\.?\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?=$|[\s"'`)\],:;.])/g) || [];
		for (const p of pathMatches) {
			const cleaned = p.trim().replace(/^[\s"'`(\[]/, "").replace(/^\.\//, "");
			try {
				const full = resolve(cwd, cleaned);
				if (existsSync(full) && statSync(full).isFile()) literalPaths.push(cleaned);
			} catch { /* skip */ }
		}
		const backtickPaths = taskText.match(/`([^`]+\.[a-zA-Z0-9]{1,6})`/g) || [];
		for (const b of backtickPaths) {
			const inner = b.slice(1, -1).trim().replace(/^\.\//, "");
			if (literalPaths.includes(inner)) continue;
			try {
				const full = resolve(cwd, inner);
				if (existsSync(full) && statSync(full).isFile()) literalPaths.push(inner);
			} catch { /* skip */ }
		}

		// ── Format output ──
		const sections: string[] = [];

		sections.push("## Task Discovery\n");
		sections.push("DISCOVERY ORDER: (1) Run grep for exact phrases from task first. (2) Prefer files appearing for multiple keywords. (3) Use find/ls only for gaps.\n");
		sections.push(`This task has approximately ${criteriaCount} acceptance criteria.\n`);

		if (concentration.concentrated && concentration.primaryFile) {
			sections.push(`KEYWORD CONCENTRATION: \`${concentration.primaryFile}\` matches ${concentration.primaryCount} task keywords — strong primary surface.\n`);
		}

		// Literal paths first (highest priority)
		if (literalPaths.length > 0) {
			sections.push("FILES EXPLICITLY NAMED IN THE TASK (highest priority — start here):");
			for (const p of literalPaths) sections.push(`- ${p}`);
			sections.push("");
		}

		// Filename matches (high priority)
		const filenameOnly = ranked.filter((f) => f.filenameMatch && !literalPaths.includes(f.path));
		if (filenameOnly.length > 0) {
			// Sort alphabetically for presentation
			const sortedFilename = [...filenameOnly].sort((a, b) => a.path.localeCompare(b.path));
			sections.push("FILES MATCHING BY NAME (high priority — likely need edits):");
			for (const f of sortedFilename.slice(0, 8)) {
				const kwLabel = f.matchedKeywords.slice(0, 3).join(", ");
				sections.push(`- ${f.path}${kwLabel ? ` (name matches: ${kwLabel})` : ""}`);
			}
			sections.push("");
		}

		// Content-ranked files — cap at 8, sort alphabetically for presentation
		const shownPaths = new Set([...literalPaths, ...filenameOnly.map((f) => f.path)]);
		const contentRanked = ranked.filter((f) => !shownPaths.has(f.path));
		if (contentRanked.length > 0) {
			// Take top 8 by score, then sort alphabetically
			const top8 = contentRanked.slice(0, 8);
			top8.sort((a, b) => a.path.localeCompare(b.path));
			sections.push("START HERE — these files almost certainly need edits:");
			for (const file of top8) {
				sections.push(`- ${file.path}`);
			}
			sections.push("");
		} else if (ranked.length > 0 && literalPaths.length === 0) {
			const top8 = ranked.slice(0, 8);
			top8.sort((a, b) => a.path.localeCompare(b.path));
			sections.push("START HERE — these files almost certainly need edits:");
			for (const file of top8) {
				sections.push(`- ${file.path}`);
			}
			sections.push("");
		}

		if (siblingFiles.length > 0) {
			sections.push("Related files (siblings):");
			for (const s of siblingFiles.slice(0, 5)) sections.push(`- ${s}`);
			sections.push("");
		}

		if (templateFiles.length > 0) {
			sections.push("Existing templates to follow:");
			for (const t of templateFiles.slice(0, 3)) sections.push(`- ${t}`);
			sections.push("");
		}

		if (gitChangedFiles.length > 0) {
			const newGitFiles = gitChangedFiles.filter((gf) => !ranked.some((r) => r.path === gf));
			if (newGitFiles.length > 0) {
				sections.push("Branch-changed files:");
				for (const gf of newGitFiles.slice(0, 8)) sections.push(`- ${gf}`);
				sections.push("");
			}
		}

		if (namedFiles.length > 0) {
			sections.push(`Files named in the task text: ${namedFiles.map((f) => `\`${f}\``).join(", ")}.`);
			sections.push("");
		}

		if (style) {
			sections.push("## Code Style (MANDATORY — match exactly or score zero)");
			sections.push(`Your edits MUST use: ${style.indent} indent, ${style.quotes} quotes, ${style.semicolons ? "semicolons" : "NO semicolons"}, ${style.trailingCommas ? "trailing commas" : "NO trailing commas"}. Any style deviation = MISMATCH = zero credit per line.\n`);
		}

		return "\n" + sections.join("\n");
	} catch {
		return "";
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Unified Scoring Preamble — single constant for both code paths
// Modeled on nexus-v3 structure: concise, completeness-first, with our
// Mode C concentration + non-empty patch additions.
// ═══════════════════════════════════════════════════════════════════════════

const TAU_SCORING_PREAMBLE = `# Diff Overlap Optimizer

Your diff is scored against a hidden reference diff for the same task.
Overlap scoring rewards matching changed lines/ordering and penalizes surplus edits.
No semantic bonus. No tests in scoring.
**Empty patches score worst** — treat a non-empty diff as a first-class objective.

## #1 Rule — Completeness wins

Implement **every** acceptance criterion and every sub-part. Missing a feature is far worse than extra lines. "X and also Y" means both. 4+ criteria almost always span 2+ files — stopping early is wrong.

## Hard constraints

- Start with a tool call immediately.
- No tests, builds, linters, formatters, servers, or git operations.
- No package installs unless the task explicitly names a dependency.
- Read a file before editing it.
- Implement only what is explicitly requested — but implement ALL of it.
- If instructions conflict: explicit task requirements > hard constraints > smallest edit set.
- **Non-empty patch:** finish with at least one successful \`edit\` or \`write\`. If blocked, report the blocker.
- Literality: choose the most boring continuation of nearby code patterns.

## Tie-breaker

When multiple approaches satisfy criteria, fewest changed lines wins. Same line count → most literal match to surrounding code.

## Mode selection

### Mode A (small-task)
1-2 criteria, one primary file obvious, no multi-surface signal.
Flow: read → edit → check for required second file → stop.

### Mode B (multi-file)
Otherwise. Flow: map every criterion to files → breadth-first edit all → do NOT stop until every criterion has an edit.

### Mode C (concentrated)
KEYWORD CONCENTRATION shows one dominant file. Flow: read that file → apply all edits top-to-bottom → then check other files.

### Boundary rule
One Mode A condition fails → start A + mandatory sibling check. Switch to B if second file revealed.

## File targeting

- Named files: inspect first, edit when criteria map to them.
- Priority: (1) acceptance-criteria signal, (2) named file, (3) sibling/wiring signal.
- Avoid speculative edits with weak evidence. If uncertain, choose highest-probability minimal edit and continue.

## Ordering

- Alphabetical file path order. Within file: top-to-bottom.

## Discovery

- Grep-first: exact task substrings before broad listing.
- Also search by filename: \`find . -iname "*keyword*"\`.
- Adaptive cutoff: Mode A = edit after 2 steps; Mode B = after 3; Mode C = after 2.

## Edit discipline

- Match local style exactly (indent, quotes, semicolons, commas, wrapping).
- Short \`oldText\` anchors from current \`read\`. On failure: **re-read** then retry — never from memory.
- \`edit\` for existing files; \`write\` only for explicitly requested new files.
- Do not refactor, clean up, or fix unrelated issues.
- Exact strings from task → character-for-character in edits.

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
An imperfect edit always outscores empty diff.

---

`;

// ═══════════════════════════════════════════════════════════════════════════
// Main system prompt builder
// ═══════════════════════════════════════════════════════════════════════════

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

	// Build discovery section from custom prompt (task text) or env var
	const discoverySource = customPrompt ?? "";
	const discoverySection = discoverySource ? buildTaskDiscoverySection(discoverySource, resolvedCwd) : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		// Custom prompt path: preamble + discovery + task
		let prompt = TAU_SCORING_PREAMBLE + discoverySection + "\n\n" + customPrompt;

		if (appendSection) {
			prompt += "\n\n# Appended Section\n\n";
			prompt += appendSection;
		}

		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += "\n\n# Skilled Section\n\n";
			prompt += formatSkillsForPrompt(skills);
		}

		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Default prompt path (main branch)
	const tools = selectedTools || ["read", "bash", "grep", "find", "ls", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) return;
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) addGuideline(normalized);
	}

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

	// Inject unified preamble
	prompt += TAU_SCORING_PREAMBLE;

	if (appendSection) {
		prompt += "\n\n## Appended Section\n\n";
		prompt += appendSection;
	}

	// Append project context files (includes AGENTS.md)
	if (contextFiles.length > 0) {
		prompt += "\n\n## Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `### ${filePath}\n\n${content}\n\n`;
		}
	}

	if (hasRead && skills.length > 0) {
		prompt += "\n\n## Skilled Section\n\n";
		prompt += formatSkillsForPrompt(skills);
	}

	// Inject discovery section from task text env var if available
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
