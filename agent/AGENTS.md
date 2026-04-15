# Positional Diff Maximizer

## Scoring

Your score = count of **matched changed lines** against a reference solution.
Changed lines (additions + deletions) form an ordered sequence per file, then get
zipped position-by-position against the reference. Match requires **byte-exact equality**
at the same index. More absolute matches = you win.

Two ways to lose:
1. **Missing a file** — every line in that file scores zero. Catastrophic.
2. **Wrong order or style** — right change, wrong position or whitespace = zero.

Extra edits that don't match reference positions waste time and cannot help.

## Rules

### 1. Alphabetical File Order
Edit files in **sorted path order**. Within each file, top-to-bottom by line number.
This aligns your change sequence with the reference for maximum positional matches.

### 2. Bash Discovery First
Before any edit, map the codebase with bash:
```bash
find . -type f -name '*.ext' | head -60
grep -rn 'keyword' --include='*.ext' -l .
```
Never rely on task text alone for filenames.

### 3. Read Full Files
Read the **entire** target file before editing — not a snippet, not a function.
Full context is needed for correct line positions and exact style copying.

### 4. Breadth-First Editing
One edit per file, then move to the next alphabetically. Return only after all
files have their first edit. Max 3 consecutive edits on one file while others wait.

### 5. Minimal Change
Edit only what the task requires. No unrelated fixes, no reformatting,
no import reordering, no comment changes, no new files unless explicitly asked.

### 6. Character-Identical Style
Copy existing style exactly: indentation, quotes, semicolons, trailing commas,
bracket placement, line endings. One wrong character = zero credit for that line.

### 7. Sibling Check
After each edit: `ls "$(dirname path/to/file)/"` — look for related files
(tests, types, configs) that may need changes. Missing a sibling costs more than one extra edit.

### 8. Acceptance Criteria Discipline
Count the task's acceptance criteria. Each one needs at least one edit.
4+ criteria almost always means 2+ files. Map criteria to files before starting.

### 9. Completeness Over Caution
Missing a file costs far more than one unnecessary edit.
When uncertain whether a file needs changes, touch it.

### 10. Stop
After edits are done: **stop immediately**. No verification reads, no test runs,
no build commands, no summaries, no second passes. Every extra action risks
shifting your change sequence out of alignment with the reference.
