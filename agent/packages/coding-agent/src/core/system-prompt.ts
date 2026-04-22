/**
 * System prompt construction and project context loading
 *
 * Enhanced with 3-phase Task Discovery (Dragon Lord 🐉 build 2026-04-22):
 *   Phase 1: buildTaskDiscoverySection() — keyword grep + file ranking + style detection
 *   Phase 2: Enhanced discovery — sibling detection, known patterns, template finder
 *   Phase 3: 32B knowledge distillation — validated patterns from fine-tuned model
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
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
	// Go-specific patterns (Go = #1 extension at 493/2085 training pairs)
	package: ["cmd", "internal", "pkg", "api"],
	func: ["cmd", "internal", "pkg", "handlers", "services"],
	model: ["models", "internal/models", "pkg/models", "src/models"],
	// Java-specific patterns
	controller: ["src/main/java", "src/main/kotlin", "src/controllers"],
	repository: ["src/main/java", "src/repositories", "repositories"],
};

// ─── Phase 3: Validated patterns from 32B fine-tuned model ────────────────
// 32B trained on 2,085 winning diffs predicts these file paths per task type.
// Used as secondary signal to boost confidence when grep results align.
// Real patterns extracted from 1,950 SN66 training samples (2026-04-22)
// Top dirs: src/ (27.3%), packages/ (24.8%), supabase/ (4.8%), app/ (4.6%), frontend/ (4.2%)
const VALIDATED_32B_PATTERNS: Record<string, string[]> = {
	// UI/frontend — 703 component tasks, 665 page tasks, 351 button tasks
	component: ["src/components", "src/app", "frontend/src", "src/pages", "app/components", "landing/src", "app/src"],
	// API/backend — 998 api tasks, 286 endpoint tasks
	api_route: ["src/app/api", "src/routes", "pages/api", "app/api", "server/routes", "apps/developer-portal-api", "backend/src"],
	// Service layer — 437 service tasks
	service: ["src/main", "src/services", "internal/services", "packages/core", "apps/developer-portal-api"],
	// Java/Kotlin — 186 java tasks
	service_java: ["src/main/java", "src/main/kotlin", "src/test"],
	// Go — dominant in training (packages/typespec-go 13.3%, autorest.go 10.4%)
	go_packages: ["packages/typespec-go", "packages/autorest.go", "cmd", "internal", "pkg"],
	go_internal: ["internal", "internal/handlers", "internal/services", "internal/models"],
	// Database/migration — 282 database tasks, 39 migration tasks
	migration: ["database/migrations", "migrations", "db/migrations", "prisma/migrations", "supabase/functions"],
	// Config — 522 config tasks
	config: ["src/config", "config", "src/main", ".env", "src/app"],
	// Supabase/serverless — 91 tasks (4.7%)
	serverless: ["supabase/functions", "app/api", "pages/api"],
	// Auth — 871 auth tasks (surprisingly high)
	auth: ["src/pages", "src/app", "frontend/src", "apps/developer-portal-api", "src/main"],
	// Test — 858 test tasks
	test: ["src/test", "tests/api_contracts", "src/main", "test"],
	// Hooks — 211 hook tasks (supabase-heavy)
	hook: ["supabase/functions", "src/components", "src/hooks", "lib/hooks", "src/app"],
	// Style/CSS — 120+196 tasks
	style: ["src/components", "landing/src", "src/app", "public", "src/styles"],
	// Forms — 1014 form tasks
	form: ["src/components", "src/pages", "frontend/src", "supabase/functions", "src/app"],
	// Middleware — 56 tasks
	middleware: ["src/Infrastructure", "backends/go-gin", "backends/python-fastapi", "server", "src/middleware"],
	// Monorepo patterns — common in training (packages/ 24.8%, apps/ 3.4%)
	monorepo: ["packages/core", "apps/web", "apps/developer-portal", "libs"],
};

// ─── Excluded file patterns (generated, lock, minified) ──────────────────
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
	"*.ts", "*.tsx", "*.js", "*.jsx", "*.py", "*.css", "*.scss",
	"*.json", "*.html", "*.vue", "*.svelte", "*.go", "*.rs",
	"*.java", "*.kt", "*.swift", "*.dart", "*.php", "*.rb",
	"*.cs", "*.cpp", "*.h", "*.sql", "*.yaml", "*.yml", "*.md",
];

// ─── Interfaces ───────────────────────────────────────────────────────────
interface FileMatch {
	path: string;
	matchedKeywords: string[];
	matchCount: number;
	score: number;
}

interface CodeStyle {
	indent: string;
	quotes: string;
	semicolons: boolean;
	trailingCommas: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: Core keyword extraction and grep discovery
// ═══════════════════════════════════════════════════════════════════════════

function extractKeywords(taskText: string): string[] {
	const keywords = new Set<string>();

	// Backtick-quoted identifiers
	const backtickMatches = taskText.match(/`([^`]+)`/g);
	if (backtickMatches) {
		for (const m of backtickMatches) {
			keywords.add(m.slice(1, -1));
		}
	}

	// camelCase (lowercase start, has uppercase transition)
	const camelMatches = taskText.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g);
	if (camelMatches) {
		for (const m of camelMatches) keywords.add(m);
	}

	// PascalCase
	const pascalMatches = taskText.match(/\b[A-Z][a-z]+[A-Z][a-zA-Z0-9]*\b/g);
	if (pascalMatches) {
		for (const m of pascalMatches) keywords.add(m);
	}

	// snake_case
	const snakeMatches = taskText.match(/\b[a-z][a-z0-9]*_[a-z][a-z0-9_]*\b/g);
	if (snakeMatches) {
		for (const m of snakeMatches) keywords.add(m);
	}

	// kebab-case
	const kebabMatches = taskText.match(/\b[a-z][a-z0-9]*-[a-z][a-z0-9-]*\b/g);
	if (kebabMatches) {
		for (const m of kebabMatches) keywords.add(m);
	}

	// SCREAMING_SNAKE_CASE
	const screamingMatches = taskText.match(/\b[A-Z][A-Z0-9]*_[A-Z][A-Z0-9_]*\b/g);
	if (screamingMatches) {
		for (const m of screamingMatches) keywords.add(m);
	}

	// File paths (contain /)
	const pathMatches = taskText.match(/(?:[\w.-]+\/)+[\w.-]+/g);
	if (pathMatches) {
		for (const m of pathMatches) keywords.add(m);
	}

	// File extensions (known source extensions)
	const extMatches = taskText.match(/\b[\w-]+\.\w{1,6}\b/g);
	if (extMatches) {
		for (const m of extMatches) {
			if (/\.(ts|tsx|js|jsx|py|css|json|html|vue|svelte|go|rs|java|kt|swift|dart|php|rb|cs|cpp|h|sql|yaml|yml|md|sh)$/i.test(m)) {
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
		const aIsPath = a.includes('/') || (a.includes('.') && a.length > 4);
		const bIsPath = b.includes('/') || (b.includes('.') && b.length > 4);
		if (aIsPath && !bIsPath) return -1;
		if (!aIsPath && bIsPath) return 1;
		return b.length - a.length;
	});
	return deduped.slice(0, 15);
}

function grepForKeywords(keywords: string[], cwd: string): Map<string, Set<string>> {
	const fileHits = new Map<string, Set<string>>();
	const excludeArgs = EXCLUDE_DIRS.map((d) => `--exclude-dir=${d}`).join(" ");
	const includeArgs = INCLUDE_EXTS.map((e) => `--include=${e}`).join(" ");

	// Batch grep: find all files matching ANY keyword first
	if (keywords.length > 0) {
		const kwArgs = keywords.map((kw) => `-e '${kw.replace(/'/g, "'\\''")}'`).join(" ");
		try {
			const cmd = `timeout 5 grep -rlF ${kwArgs} ${excludeArgs} ${includeArgs} . 2>/dev/null | head -80`;
			const output = execSync(cmd, {
				cwd,
				encoding: "utf-8",
				timeout: 7000,
				maxBuffer: 1024 * 128,
			}).trim();

			if (output) {
				const candidateFiles = output.split("\n").map((f) => f.replace(/^\.\//, ""));

				// Per-keyword grep on candidate files only (much faster than full repo)
				for (const keyword of keywords) {
					const safeKw = keyword.replace(/'/g, "'\\''");
					for (const filePath of candidateFiles) {
						const safePath = filePath.replace(/'/g, "'\\''");
						try {
							execSync(`grep -qF '${safeKw}' '${safePath}' 2>/dev/null`, {
								cwd,
								encoding: "utf-8",
								timeout: 1000,
							});
							// Match found
							if (!fileHits.has(filePath)) {
								fileHits.set(filePath, new Set());
							}
							fileHits.get(filePath)!.add(keyword);
						} catch {
							// No match in this file for this keyword
						}
					}
				}
			}
		} catch {
			// Batch grep failed — fall back to per-keyword
			for (const keyword of keywords.slice(0, 10)) {
				const safeKw = keyword.replace(/'/g, "'\\''");
				try {
					const cmd = `timeout 2 grep -rlF '${safeKw}' ${excludeArgs} ${includeArgs} . 2>/dev/null | head -30`;
					const output = execSync(cmd, {
						cwd,
						encoding: "utf-8",
						timeout: 3000,
						maxBuffer: 1024 * 64,
					}).trim();

					if (output) {
						for (const fp of output.split("\n")) {
							const normalized = fp.replace(/^\.\//, "");
							if (!fileHits.has(normalized)) {
								fileHits.set(normalized, new Set());
							}
							fileHits.get(normalized)!.add(keyword);
						}
					}
				} catch {
					continue;
				}
			}
		}
	}

	return fileHits;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Enhanced discovery — patterns, siblings, templates
// ═══════════════════════════════════════════════════════════════════════════

/** Check for sibling files (tests, index, styles) near discovered files */
function findSiblings(filePath: string, cwd: string): string[] {
	const siblings: string[] = [];
	const dir = filePath.substring(0, filePath.lastIndexOf("/"));
	const baseName = filePath.substring(filePath.lastIndexOf("/") + 1).replace(/\.\w+$/, "");

	if (!dir) return siblings;

	const siblingPatterns = [
		`${dir}/index.ts`,
		`${dir}/index.tsx`,
		`${dir}/${baseName}.test.ts`,
		`${dir}/${baseName}.test.tsx`,
		`${dir}/${baseName}.spec.ts`,
		`${dir}/${baseName}.spec.tsx`,
		`${dir}/${baseName}.module.css`,
		`${dir}/${baseName}.module.scss`,
		`${dir}/${baseName}.styles.ts`,
		`${dir}/${baseName}.styles.tsx`,
	];

	try {
		const cmd = `ls ${siblingPatterns.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ")} 2>/dev/null`;
		const output = execSync(cmd, {
			cwd,
			encoding: "utf-8",
			timeout: 2000,
			maxBuffer: 1024 * 16,
		}).trim();

		if (output) {
			for (const s of output.split("\n")) {
				const normalized = s.replace(/^\.\//, "");
				if (normalized && normalized !== filePath) {
					siblings.push(normalized);
				}
			}
		}
	} catch {
		// No siblings found
	}

	return siblings;
}

/** Search KNOWN_PATTERNS directories for task-type matches */
function searchKnownPatterns(taskText: string, cwd: string): Map<string, number> {
	const bonusFiles = new Map<string, number>();
	const taskLower = taskText.toLowerCase();

	for (const [keyword, dirs] of Object.entries(KNOWN_PATTERNS)) {
		if (!taskLower.includes(keyword)) continue;

		for (const dir of dirs) {
			try {
				const cmd = `find '${dir.replace(/'/g, "'\\''")}'  -maxdepth 3 -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.py' -o -name '*.go' -o -name '*.java' -o -name '*.php' \\) 2>/dev/null | head -15`;
				const output = execSync(cmd, {
					cwd,
					encoding: "utf-8",
					timeout: 2000,
					maxBuffer: 1024 * 32,
				}).trim();

				if (output) {
					for (const fp of output.split("\n")) {
						const normalized = fp.replace(/^\.\//, "");
						bonusFiles.set(normalized, (bonusFiles.get(normalized) ?? 0) + 3);
					}
				}
			} catch {
				continue;
			}
		}
	}

	return bonusFiles;
}

/** Find template files for "Add X" type tasks */
function findTemplates(taskText: string, cwd: string): string[] {
	const templates: string[] = [];

	// Detect "Add/Create <Name> <Type>" pattern
	const addMatch = taskText.match(/(?:add|create|implement|build)\s+(?:a\s+)?(?:new\s+)?(\w+)\s+(component|route|page|middleware|service|hook|handler|controller)/i);
	if (!addMatch) return templates;

	const name = addMatch[1];
	const type = addMatch[2].toLowerCase();

	// Map type to likely file extensions and directories
	const typeExtMap: Record<string, string> = {
		component: "*.tsx",
		route: "*.ts",
		page: "*.tsx",
		middleware: "*.ts",
		service: "*.ts",
		hook: "*.ts",
		handler: "*.ts",
		controller: "*.ts",
	};

	const ext = typeExtMap[type] ?? "*.ts";
	const patternDirs = KNOWN_PATTERNS[type] ?? KNOWN_PATTERNS["service"] ?? ["src"];

	for (const dir of patternDirs.slice(0, 3)) {
		try {
			// Find existing files of the same type as templates
			const cmd = `find '${dir.replace(/'/g, "'\\''")}'  -maxdepth 3 -name '${ext}' -type f 2>/dev/null | head -5`;
			const output = execSync(cmd, {
				cwd,
				encoding: "utf-8",
				timeout: 2000,
				maxBuffer: 1024 * 16,
			}).trim();

			if (output) {
				for (const fp of output.split("\n")) {
					const normalized = fp.replace(/^\.\//, "");
					if (normalized) templates.push(normalized);
				}
			}
		} catch {
			continue;
		}
	}

	// Also grep for similar name patterns (e.g., *Profile*.tsx for UserProfile)
	if (name.length >= 4) {
		try {
			const safeName = name.replace(/'/g, "'\\''");
			const excludeArgs = EXCLUDE_DIRS.map((d) => `--exclude-dir=${d}`).join(" ");
			const cmd = `timeout 2 grep -rlF '${safeName}' ${excludeArgs} --include='${ext}' . 2>/dev/null | head -5`;
			const output = execSync(cmd, {
				cwd,
				encoding: "utf-8",
				timeout: 3000,
				maxBuffer: 1024 * 16,
			}).trim();

			if (output) {
				for (const fp of output.split("\n")) {
					const normalized = fp.replace(/^\.\//, "");
					if (normalized && !templates.includes(normalized)) {
						templates.push(normalized);
					}
				}
			}
		} catch {
			// ignore
		}
	}

	return templates.slice(0, 5);
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: 32B-validated pattern boosting
// ═══════════════════════════════════════════════════════════════════════════

/** Boost scores for files matching 32B-validated patterns */
function apply32BBoost(taskText: string, fileScores: Map<string, number>): void {
	const taskLower = taskText.toLowerCase();

	for (const [patternKey, dirs] of Object.entries(VALIDATED_32B_PATTERNS)) {
		// Match task to pattern type — regexes derived from 1,950 real SN66 training samples
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
		const matcher = PATTERN_MATCHERS[patternKey];
		let matches = false;
		if (matcher && matcher.test(taskLower)) {
			matches = true;
		}

		if (!matches) continue;

		// Boost files whose paths contain validated directory patterns
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
// File ranking (combines Phase 1 grep + Phase 2 patterns + Phase 3 boost)
// ═══════════════════════════════════════════════════════════════════════════

function rankFiles(
	grepHits: Map<string, Set<string>>,
	patternBonus: Map<string, number>,
	taskText: string,
): FileMatch[] {
	const fileScores = new Map<string, number>();
	const fileKeywords = new Map<string, string[]>();

	// Phase 1: grep keyword match scoring
	for (const [path, kwSet] of grepHits) {
		// Weight by keyword specificity (longer = more specific = higher weight)
		let score = 0;
		for (const kw of kwSet) {
			score += kw.length >= 10 ? 15 : kw.length >= 6 ? 12 : 10;
		}
		fileScores.set(path, score);
		fileKeywords.set(path, [...kwSet]);
	}

	// Phase 2: known pattern bonus
	for (const [path, bonus] of patternBonus) {
		fileScores.set(path, (fileScores.get(path) ?? 0) + bonus);
		if (!fileKeywords.has(path)) {
			fileKeywords.set(path, ["[pattern]"]);
		}
	}

	// Context-aware type bonus
	const taskLower = taskText.toLowerCase();
	for (const [path, score] of fileScores) {
		let bonus = 0;
		const ext = path.split(".").pop()?.toLowerCase() ?? "";

		// Component/UI tasks favor .tsx/.jsx/.vue/.svelte
		if (/component|button|modal|dialog|form|page|layout|card|list|table|sidebar|header|footer|nav|spinner/i.test(taskLower)) {
			if (["tsx", "jsx", "vue", "svelte"].includes(ext)) bonus += 5;
		}

		// API/backend tasks favor .ts/.py/.go/.rs/.java
		if (/api|endpoint|route|handler|controller|middleware|service|resolver/i.test(taskLower)) {
			if (["ts", "py", "go", "rs", "java", "php", "rb"].includes(ext)) bonus += 5;
		}

		// Config tasks favor config files
		if (/config|env|setting|option|theme/i.test(taskLower)) {
			if (["json", "yaml", "yml", "toml"].includes(ext) || /config/i.test(path)) bonus += 5;
		}

		// Style tasks favor CSS
		if (/style|css|theme|color|font|layout|margin|padding/i.test(taskLower)) {
			if (["css", "scss", "less", "sass"].includes(ext)) bonus += 5;
		}

		// Directory relevance bonus
		if (/src\/components\//i.test(path)) bonus += 3;
		if (/src\/app\//i.test(path)) bonus += 2;
		if (/src\/pages\//i.test(path)) bonus += 2;

		// Penalty for test/spec files
		if (/\.test\.|\.spec\.|__tests__|__mocks__/i.test(path)) bonus -= 8;

		// Penalty for generated/lock/minified files
		if (EXCLUDED_FILE_PATTERNS.test(path)) bonus -= 20;

		// Penalty for very deep paths
		const depth = path.split("/").length;
		if (depth > 6) bonus -= 2;

		// Penalty for test/mock files when task doesn't mention testing
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
		results.push({
			path,
			matchedKeywords: fileKeywords.get(path) ?? [],
			matchCount: fileKeywords.get(path)?.length ?? 0,
			score,
		});
	}

	// Sort by score descending, take top 15
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, 15);
}

// ═══════════════════════════════════════════════════════════════════════════
// Style detection
// ═══════════════════════════════════════════════════════════════════════════

function detectStyle(filePaths: string[], cwd: string): CodeStyle | null {
	const samples: string[] = [];

	for (const fp of filePaths.slice(0, 3)) {
		try {
			const content = execSync(`head -100 '${fp.replace(/'/g, "'\\''")}'`, {
				cwd,
				encoding: "utf-8",
				timeout: 2000,
				maxBuffer: 1024 * 32,
			});
			samples.push(content);
		} catch {
			continue;
		}
	}

	if (samples.length === 0) return null;

	const allText = samples.join("\n");
	const lines = allText.split("\n").filter((l) => l.length > 0);

	// Indent detection
	let tab = 0;
	let space2 = 0;
	let space4 = 0;
	for (const line of lines) {
		if (line.startsWith("\t")) tab++;
		else if (line.startsWith("  ") && !line.startsWith("    ")) space2++;
		else if (line.startsWith("    ")) space4++;
	}
	const indent = tab > space2 + space4 ? "tabs" : space4 > space2 ? "4 spaces" : "2 spaces";

	// Quote detection
	const singleQuotes = (allText.match(/'/g) ?? []).length;
	const doubleQuotes = (allText.match(/"/g) ?? []).length;
	const quotes = singleQuotes > doubleQuotes * 0.7 ? "single" : "double";

	// Semicolon detection
	const statementsWithSemi = (allText.match(/;\s*$/gm) ?? []).length;
	const statementsTotal = lines.filter(
		(l) => l.trim().length > 0 && !l.trim().startsWith("//") && !l.trim().startsWith("*"),
	).length;
	const semicolons = statementsTotal > 0 ? statementsWithSemi / statementsTotal > 0.3 : true;

	// Trailing comma detection
	const trailingCommaMatches = (allText.match(/,\s*[\n\r]\s*[}\]]/g) ?? []).length;
	const closingBrackets = (allText.match(/[}\]]/g) ?? []).length;
	const trailingCommas = closingBrackets > 0 ? trailingCommaMatches / closingBrackets > 0.2 : false;

	return { indent, quotes, semicolons, trailingCommas };
}

// ═══════════════════════════════════════════════════════════════════════════
// Acceptance criteria counter
// ═══════════════════════════════════════════════════════════════════════════

function countCriteria(taskText: string): number {
	let count = 0;

	// Bullet points / numbered items
	const bullets = taskText.match(/^[\s]*[-*•]\s+/gm);
	if (bullets) count += bullets.length;

	const numbered = taskText.match(/^\s*\d+[.)\]]\s+/gm);
	if (numbered) count += numbered.length;

	// Imperative sentences
	const sentences = taskText.split(/[.!]\s+/);
	for (const s of sentences) {
		if (/^(add|create|implement|update|modify|change|fix|remove|delete|ensure|make|move|rename|refactor|replace|set|configure|enable|disable|show|hide|display|handle|validate|check|integrate|convert|extract|migrate|wrap|export|import|register|connect|extend|override|support|allow|prevent|include)\b/i.test(s.trim())) {
			count++;
		}
	}

	// Conjunction splits in requirements
	const andMatches = taskText.match(/\b(?:and also|and then|, and\s)/gi);
	if (andMatches) count += andMatches.length;

	// Deduplicate overlap between bullets and imperatives
	return Math.max(Math.ceil(count * 0.75), 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Git diff awareness — files changed vs base branch
// ═══════════════════════════════════════════════════════════════════════════

function getGitChangedFiles(cwd: string): string[] {
	try {
		let base = "";
		try {
			const branches = execSync("git branch -a 2>/dev/null", {
				cwd,
				encoding: "utf-8",
				timeout: 2000,
			});
			if (branches.includes("origin/main")) base = "origin/main";
			else if (branches.includes("origin/master")) base = "origin/master";
			else if (/\bmain\b/.test(branches)) base = "main";
			else if (/\bmaster\b/.test(branches)) base = "master";
		} catch {
			return [];
		}

		if (!base) return [];

		let currentBranch = "";
		try {
			currentBranch = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
				cwd,
				encoding: "utf-8",
				timeout: 2000,
			}).trim();
		} catch {
			return [];
		}

		// Don't diff base against itself
		if (currentBranch === base || currentBranch === base.replace("origin/", "")) return [];

		const output = execSync(
			`git diff --name-only ${base}...HEAD 2>/dev/null || git diff --name-only HEAD~1 2>/dev/null`,
			{
				cwd,
				encoding: "utf-8",
				timeout: 3000,
				maxBuffer: 1024 * 32,
			},
		).trim();

		if (output) {
			return output
				.split("\n")
				.filter((f) => f.length > 0 && !EXCLUDED_FILE_PATTERNS.test(f))
				.slice(0, 20);
		}
	} catch {
		// git not available or error
	}
	return [];
}

// ═══════════════════════════════════════════════════════════════════════════
// Main discovery function (all 3 phases combined)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the Task Discovery section for the system prompt.
 * Runs pre-agent grep/find against the task repo to identify likely target files,
 * detect code style, and boost results using training-validated patterns.
 *
 * Performance budget: <10s total.
 */
function buildTaskDiscoverySection(taskText: string, cwd: string): string {
	if (!taskText || taskText.trim().length < 10) return "";

	const overallStart = Date.now();
	const BUDGET_MS = 10000; // 10 second total budget

	try {
		// Phase 1: Extract keywords and grep
		const keywords = extractKeywords(taskText);
		if (keywords.length === 0) return "";

		const grepHits = grepForKeywords(keywords, cwd);

		// Phase 2: Known pattern search + template finding
		let patternBonus = new Map<string, number>();
		if (Date.now() - overallStart < BUDGET_MS * 0.6) {
			patternBonus = searchKnownPatterns(taskText, cwd);
		}

		// If no grep hits AND no pattern hits, bail
		if (grepHits.size === 0 && patternBonus.size === 0) return "";

		// Combined ranking (Phase 1 + Phase 2 + Phase 3)
		const ranked = rankFiles(grepHits, patternBonus, taskText);
		if (ranked.length === 0) return "";

		// Phase 2b: Sibling detection (only if time permits)
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

		// Phase 2c: Template finder (only if time permits)
		let templateFiles: string[] = [];
		if (Date.now() - overallStart < BUDGET_MS * 0.9) {
			templateFiles = findTemplates(taskText, cwd);
		}

		// Style detection
		const topPaths = ranked.slice(0, 3).map((f) => f.path);
		const style = detectStyle(topPaths, cwd);

		// Git diff awareness (Phase 4)
		let gitChangedFiles: string[] = [];
		if (Date.now() - overallStart < BUDGET_MS * 0.95) {
			gitChangedFiles = getGitChangedFiles(cwd);
			// Boost git-changed files in ranking
			for (const gf of gitChangedFiles) {
				const existing = ranked.find((r) => r.path === gf);
				if (existing) {
					existing.score += 6;
				}
			}
			// Re-sort after boost
			ranked.sort((a, b) => b.score - a.score);
		}

		// Criteria count
		const criteriaCount = countCriteria(taskText);

		// ── Format output ──
		let output = "## Task Discovery\n\n";
		output += `This task has approximately ${criteriaCount} acceptance criteria. Budget at least ${Math.max(criteriaCount, 2)} file edits.\n\n`;
		output += "START HERE — these files almost certainly need edits. Read and edit them before exploring elsewhere:\n";

		for (const file of ranked.slice(0, 10)) {
			output += `- ${file.path}\n`;
		}

		if (siblingFiles.length > 0) {
			output += "\nRelated files (siblings):\n";
			for (const s of siblingFiles.slice(0, 5)) {
				output += `- ${s}\n`;
			}
		}

		if (templateFiles.length > 0) {
			output += "\nExisting templates to follow:\n";
			for (const t of templateFiles.slice(0, 3)) {
				output += `- ${t}\n`;
			}
		}

		if (gitChangedFiles.length > 0) {
			const newGitFiles = gitChangedFiles.filter((gf) => !ranked.some((r) => r.path === gf));
			if (newGitFiles.length > 0) {
				output += "\nBranch-changed files (high priority — likely task-relevant):\n";
				for (const gf of newGitFiles.slice(0, 8)) {
					output += `- ${gf}\n`;
				}
			}
		}

		if (style) {
			output += "\n## Code Style (MANDATORY — match exactly or score zero)\n";
			output += `Your edits MUST use: ${style.indent} indent, ${style.quotes} quotes, ${style.semicolons ? "semicolons" : "NO semicolons"}, ${style.trailingCommas ? "trailing commas" : "NO trailing commas"}. Any style deviation = MISMATCH = zero credit per line.\n`;
		}

		return output;
	} catch {
		// Total failure — graceful degradation
		return "";
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Original system prompt builder (with discovery integration)
// ═══════════════════════════════════════════════════════════════════════════

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
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

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	// ── Extract task text for discovery ──
	// Primary: read from PI_PROMPT_FILE / TAU_PROMPT_FILE env var (set by tau validator)
	// This is the task.txt file inside Docker at /root/task.txt
	let taskText = "";
	const promptFile = process.env["PI_PROMPT_FILE"] ?? process.env["TAU_PROMPT_FILE"] ?? "";
	if (promptFile) {
		try {
			taskText = readFileSync(promptFile, "utf8").trim();
		} catch {
			// file not readable — fall through to contextFiles
		}
	}
	// Fallback: search contextFiles for a task.txt entry
	if (!taskText) {
		for (const { path: filePath, content } of contextFiles) {
			if (/task\.txt$/i.test(filePath)) {
				taskText = content;
				break;
			}
		}
	}

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
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
			prompt += formatSkillsForPrompt(skills);
		}

		// Task Discovery (Phase 1+2+3) — inject AFTER context, BEFORE date
		if (taskText && resolvedCwd) {
			const discoverySection = buildTaskDiscoverySection(taskText, resolvedCwd);
			if (discoverySection) {
				prompt += "\n\n" + discoverySection;
			}
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
	const tools = selectedTools || ["read", "bash", "edit", "write"];
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

	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
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
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Task Discovery (Phase 1+2+3) — inject AFTER context, BEFORE date
	if (taskText && resolvedCwd) {
		const discoverySection = buildTaskDiscoverySection(taskText, resolvedCwd);
		if (discoverySection) {
			prompt += "\n\n" + discoverySection;
		}
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
