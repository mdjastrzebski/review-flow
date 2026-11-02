// One-off miner for bug cases: a merged fix PR that names the PR that introduced the bug.
// The introducing PR is the case; the lines the fix changes, traced back with `git blame`, are
// the bug's location (the SZZ method).
//
//   node eval/scripts/mine.ts search <out.json>              # GitHub search, 1 request per repo
//   node eval/scripts/mine.ts locate <in.json> <clones-dir> <out.json>
//   node eval/scripts/mine.ts clean <clones-dir> <out.json>   # clean-case candidates
//   node eval/scripts/mine.ts build <located.json> <clean.json> <clones-dir>   # writes eval/cases/
//
// Needs an authenticated `gh`. `locate` clones each repo into <clones-dir> (a few MB each).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const REPOS = [
  "pallets/click",
  "pallets/flask",
  "pallets/jinja",
  "pallets/werkzeug",
  "encode/httpx",
  "Kludex/starlette",
  "python-attrs/attrs",
  "marshmallow-code/marshmallow",
  "fastapi/typer",
  "psf/requests",
  "pytest-dev/pluggy",
  "yargs/yargs",
  "tj/commander.js",
  "sindresorhus/ky",
  "sindresorhus/execa",
  "unjs/ofetch",
  "h3js/h3",
  "honojs/hono",
  "koajs/koa",
  "expressjs/express",
  "pmndrs/zustand",
  "immerjs/immer",
  "spf13/cobra",
  "urfave/cli",
  "go-chi/chi",
  "gorilla/mux",
  "spf13/viper",
];

/** A keyword near a PR reference, either order: "regression introduced by #12", "#12 broke". */
const KEYWORDS = "introduced|regression|regressed|caused|broke|broken|since";
const REFERENCE = new RegExp(
  `(?:\\b(?:${KEYWORDS})\\b[^\\n#]{0,60}?(?:#|/pull/)(\\d+))|(?:(?:#|/pull/)(\\d+)[^\\n#]{0,30}?\\b(?:${KEYWORDS})\\b)`,
  "gi",
);

/** Separate words, so `gh` doesn't quote them as one phrase. */
const SEARCH_TERMS = [
  "introduced",
  "OR",
  "regression",
  "OR",
  "regressed",
  "OR",
  "broke",
  "OR",
  "caused",
];

/** Paths that aren't code under review: tests, docs, CI, changelogs, config. */
const NOT_CODE =
  /(^|\/)(tests?|__tests__|testing|docs?|examples?|\.github|benchmarks?)\/|(^|\/)(test_[^/]*|[^/]*_test\.\w+|[^/]*\.(test|spec)\.\w+)$|\.(md|mdx|rst|txt|ya?ml|json|lock|toml|cfg|ini)$|(^|\/)CHANGES/i;

interface Pr {
  number: number;
  title: string;
  url: string;
  body?: string;
}

interface Candidate {
  repo: string;
  fix: Pr;
  intro: number;
  mention: string;
}

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 << 20,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gh<T>(endpoint: string): T {
  return JSON.parse(run("gh", ["api", endpoint]));
}

function git(repoDir: string, ...args: string[]): string {
  return run("git", args, repoDir);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function search(out: string): Promise<void> {
  const candidates: Candidate[] = [];
  for (const repo of REPOS) {
    const prs: Pr[] = JSON.parse(
      run("gh", [
        "search",
        "prs",
        "--repo",
        repo,
        "--merged",
        "--limit",
        "100",
        "--json",
        "number,title,url,body",
        "--",
        ...SEARCH_TERMS,
      ]),
    );
    let found = 0;
    for (const pr of prs) {
      const text = `${pr.title}\n${pr.body ?? ""}`;
      const seen = new Set<number>();
      for (const match of text.matchAll(REFERENCE)) {
        const intro = Number(match[1] ?? match[2]);
        if (intro >= pr.number || seen.has(intro)) continue;
        seen.add(intro);
        candidates.push({
          repo,
          fix: { number: pr.number, title: pr.title, url: pr.url, body: pr.body },
          intro,
          mention: match[0],
        });
        found++;
      }
    }
    console.log(`${repo}: ${prs.length} PRs, ${found} references`);
    // Sequential on purpose: the search API allows 30 requests per minute.
    // oxlint-disable-next-line no-await-in-loop
    await sleep(2500);
  }
  writeFileSync(out, `${JSON.stringify(candidates, null, 2)}\n`);
}

interface PullInfo {
  number: number;
  title: string;
  html_url: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
}

/** Base and head of a merged PR on the default branch, or null when its commit range is unclear. */
function prRange(repoDir: string, pr: PullInfo): { base: string; head: string } | null {
  if (!pr.merged_at || !pr.merge_commit_sha) return null;
  const head = pr.merge_commit_sha;
  try {
    git(repoDir, "cat-file", "-e", `${head}^{commit}`);
  } catch {
    return null;
  }
  const base = git(repoDir, "rev-parse", `${head}^1`).trim();
  // A rebase merge of several commits leaves only the last one at merge_commit_sha; the stats
  // then differ from the PR's, so skip it.
  const [additions, deletions] = shortstat(repoDir, base, head);
  if (additions !== pr.additions || deletions !== pr.deletions) return null;
  return { base, head };
}

function shortstat(repoDir: string, base: string, head: string): [number, number] {
  const stat = git(repoDir, "diff", "--shortstat", base, head);
  return [
    Number(/(\d+) insertion/.exec(stat)?.[1] ?? 0),
    Number(/(\d+) deletion/.exec(stat)?.[1] ?? 0),
  ];
}

interface BlameLine {
  sha: string;
  origLine: number;
  finalLine: number;
  file: string;
}

function blame(
  repoDir: string,
  rev: string,
  file: string,
  start?: number,
  end?: number,
): BlameLine[] {
  const range = start === undefined ? [] : ["-L", `${start},${end}`];
  let output: string;
  try {
    output = git(repoDir, "blame", "--line-porcelain", ...range, rev, "--", file);
  } catch {
    return [];
  }
  const lines: BlameLine[] = [];
  let current: BlameLine | undefined;
  for (const line of output.split("\n")) {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(line);
    if (header) {
      current = {
        sha: header[1]!,
        origLine: Number(header[2]),
        finalLine: Number(header[3]),
        file,
      };
      lines.push(current);
    } else if (line.startsWith("filename ") && current) {
      current.file = line.slice("filename ".length);
    }
  }
  return lines;
}

interface Location {
  file: string;
  start: number;
  end: number;
}

/** Lines the fix removed or inserted next to, traced to the intro PR and mapped to its head. */
function locate(
  repoDir: string,
  intro: { base: string; head: string },
  fixSha: string,
): Location[] {
  const introCommits = new Set(
    git(repoDir, "rev-list", `${intro.base}..${intro.head}`).split("\n").filter(Boolean),
  );
  const fixParent = `${fixSha}^1`;
  const diff = git(repoDir, "diff", "-U0", "--no-renames", fixParent, fixSha);
  const touched: BlameLine[] = [];
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      const name = line.slice(4);
      file =
        name === "/dev/null" || NOT_CODE.test(name.replace(/^a\//, ""))
          ? null
          : name.replace(/^a\//, "");
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    // A pure insertion after line `start`: blame the lines around it.
    const [from, to] = count > 0 ? [start, start + count - 1] : [Math.max(1, start), start + 1];
    touched.push(
      ...blame(repoDir, fixParent, file, from, to).filter((entry) => introCommits.has(entry.sha)),
    );
  }

  // Map (commit, line in that commit) to the line in the intro head's version of the file.
  const headLines = new Map<string, number[]>();
  for (const name of new Set(touched.map((entry) => entry.file))) {
    const map = new Map<string, number>();
    for (const entry of blame(repoDir, intro.head, name))
      map.set(`${entry.sha}:${entry.origLine}`, entry.finalLine);
    const mapped = touched
      .filter((entry) => entry.file === name)
      .map((entry) => map.get(`${entry.sha}:${entry.origLine}`))
      .filter((line): line is number => line !== undefined);
    if (mapped.length > 0)
      headLines.set(
        name,
        [...new Set(mapped)].toSorted((a, b) => a - b),
      );
  }

  const locations: Location[] = [];
  for (const [name, lines] of headLines) {
    let range: Location | undefined;
    for (const line of lines) {
      if (range && line - range.end <= 3) range.end = line;
      else locations.push((range = { file: name, start: line, end: line }));
    }
  }
  return locations;
}

function locateAll(input: string, clonesDir: string, out: string): void {
  const candidates: Candidate[] = JSON.parse(readFileSync(input, "utf8"));
  const results = [];
  for (const candidate of candidates) {
    const repoDir = path.join(clonesDir, candidate.repo.replace("/", "__"));
    if (!existsSync(repoDir))
      run("git", ["clone", "--quiet", `https://github.com/${candidate.repo}`, repoDir]);
    const label = `${candidate.repo}#${candidate.intro} (fix #${candidate.fix.number})`;
    let intro: PullInfo;
    let fix: PullInfo;
    try {
      intro = gh<PullInfo>(`repos/${candidate.repo}/pulls/${candidate.intro}`);
      fix = gh<PullInfo>(`repos/${candidate.repo}/pulls/${candidate.fix.number}`);
    } catch {
      console.log(`${label}: not a PR`);
      continue;
    }
    const introRange = prRange(repoDir, intro);
    const fixRange = prRange(repoDir, fix);
    if (!introRange || !fixRange) {
      console.log(`${label}: unclear commit range`);
      continue;
    }
    const locations = locate(repoDir, introRange, fixRange.head);
    console.log(
      `${label}: ${locations.length} locations, intro +${intro.additions} -${intro.deletions}`,
    );
    results.push({
      repo: candidate.repo,
      intro: {
        number: intro.number,
        title: intro.title,
        url: intro.html_url,
        ...introRange,
        files: intro.changed_files,
        additions: intro.additions,
        deletions: intro.deletions,
      },
      fix: {
        number: fix.number,
        title: fix.title,
        url: fix.html_url,
        sha: fixRange.head,
        body: candidate.fix.body,
      },
      mention: candidate.mention,
      locations,
    });
  }
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
}

const FIX_SUBJECT = /\b(fix(es|ed)?|bug|revert|regress(ion)?|broke|hotfix)\b/i;
const SKIP_SUBJECT =
  /\b(fix(es|ed)?|bug|revert|regress|typo|docs?|chore|ci|deps?|bump|release|version|tests?|lint|format)\b/i;

/**
 * Clean candidates: merged PRs (squash or merge commits on the default branch) from 2022 to
 * mid-2026 that change 20 to 400 code lines, aren't fixes themselves, and that no later
 * fix-like commit touches: none of its removed lines trace back to the PR.
 */
function clean(clonesDir: string, out: string): void {
  const results = [];
  for (const repo of REPOS) {
    const repoDir = path.join(clonesDir, repo.replace("/", "__"));
    if (!existsSync(repoDir)) continue;
    const log = git(
      repoDir,
      "log",
      "--first-parent",
      "--since=2022-01-01",
      "--until=2026-05-01",
      "--format=%H%x09%cs%x09%s",
    );
    let found = 0;
    for (const line of log.split("\n").filter(Boolean)) {
      const [head, date, subject] = line.split("\t") as [string, string, string];
      const pr =
        /\(#(\d+)\)$/.exec(subject)?.[1] ?? /^Merge pull request #(\d+)/.exec(subject)?.[1];
      if (!pr || SKIP_SUBJECT.test(subject)) continue;
      const base = git(repoDir, "rev-parse", `${head}^1`).trim();
      const codeFiles: string[] = [];
      let codeLines = 0;
      let allLines = 0;
      for (const row of git(repoDir, "diff", "--numstat", base, head).split("\n").filter(Boolean)) {
        const [added, removed, file] = row.split("\t") as [string, string, string];
        const lines = Number(added) + Number(removed);
        if (Number.isNaN(lines)) continue;
        allLines += lines;
        if (!NOT_CODE.test(file)) {
          codeFiles.push(file);
          codeLines += lines;
        }
      }
      if (codeLines < 20 || allLines > 400) continue;
      const later = git(repoDir, "log", "--format=%H%x09%s", `${head}..HEAD`, "--", ...codeFiles)
        .split("\n")
        .filter((entry) => FIX_SUBJECT.test(entry.split("\t")[1] ?? ""));
      if (later.some((entry) => locate(repoDir, { base, head }, entry.split("\t")[0]!).length > 0))
        continue;
      results.push({
        repo,
        pr: Number(pr),
        title: subject,
        date,
        base,
        head,
        codeFiles: codeFiles.length,
        codeLines,
        allLines,
        laterFixes: later.length,
      });
      if (++found >= 6) break;
    }
    console.log(`${repo}: ${found} clean candidates`);
  }
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
}

/**
 * Bug cases picked by hand from `locate` output: the fix is a real bug fix (not docs, CI, typing
 * or performance), the intro PR changes at most about 500 lines, at most 3 per repo, and the
 * blamed lines point at the faulty code.
 */
const BUG_CASES = [
  "pallets/click#3126",
  "pallets/click#2829",
  "pallets/flask#2256",
  "pallets/jinja#858",
  "pallets/werkzeug#1540",
  "pallets/werkzeug#891",
  "Kludex/starlette#3410",
  "marshmallow-code/marshmallow#2894",
  "fastapi/typer#1128",
  "fastapi/typer#1018",
  "psf/requests#6655",
  "psf/requests#4718",
  "pytest-dev/pluggy#210",
  "yargs/yargs#556",
  "sindresorhus/execa#199",
  "h3js/h3#1428",
  "h3js/h3#1372",
  "honojs/hono#5133",
  "honojs/hono#5205",
  "honojs/hono#2080",
  "spf13/cobra#889",
  "urfave/cli#2163",
  "urfave/cli#2245",
  "urfave/cli#2237",
  "go-chi/chi#926",
];

/** Clean cases picked from `clean` output: behavior changes, not refactors, docs, or deprecations. */
const CLEAN_CASES = [
  "pallets/werkzeug#3163",
  "Kludex/starlette#3143",
  "encode/httpx#3373",
  "psf/requests#6154",
  "python-attrs/attrs#1463",
  "tj/commander.js#2405",
  "honojs/hono#4862",
  "h3js/h3#1328",
  "spf13/cobra#1559",
  "go-chi/chi#986",
];

/** The smoke set: the smallest cases, for a quick end-to-end check. */
const SMOKE = new Set([
  "pallets/click#2829",
  "h3js/h3#1372",
  "urfave/cli#2245",
  "pallets/werkzeug#3163",
  "go-chi/chi#986",
]);

/** The baseline set: small diffs across languages, plus larger ones with more clean cases. */
const BASELINE = new Set([
  "sindresorhus/execa#199",
  "spf13/cobra#1559",
  "psf/requests#6154",
  "Kludex/starlette#3143",
  "pallets/click#2829",
  "pallets/werkzeug#1540",
  "fastapi/typer#1128",
  "honojs/hono#5133",
  "h3js/h3#1372",
  "urfave/cli#2245",
  "pallets/werkzeug#3163",
  "go-chi/chi#986",
]);

/** The smallest set a case belongs to (`smoke` within `baseline` within `full`). */
function presetOf(key: string): "smoke" | "baseline" | "full" {
  return SMOKE.has(key) ? "smoke" : BASELINE.has(key) ? "baseline" : "full";
}

/**
 * Where blame misses the bug. chi#926 added `Discard` but left the `Flush` methods writing to
 * the original writer; the fix only inserted code, so no intro line was blamed.
 */
const LOCATION_OVERRIDES: Record<string, Location[]> = {
  "go-chi/chi#926 fix#1185": [
    { file: "middleware/wrap_writer.go", start: 135, end: 137 },
    { file: "middleware/wrap_writer.go", start: 144, end: 147 },
    { file: "middleware/wrap_writer.go", start: 169, end: 172 },
    { file: "middleware/wrap_writer.go", start: 191, end: 194 },
  ],
};

interface Located {
  repo: string;
  intro: {
    number: number;
    title: string;
    url: string;
    base: string;
    head: string;
    files: number;
    additions: number;
    deletions: number;
  };
  fix: { number: number; title: string; url: string };
  locations: Location[];
}

interface CleanCandidate {
  repo: string;
  pr: number;
  title: string;
  base: string;
  head: string;
}

function caseId(key: string): string {
  const [repo, number] = key.split("#") as [string, string];
  const name = repo === "urfave/cli" ? "urfave-cli" : repo.split("/")[1]!.replace(/\.js$/, "");
  return `${name}-${number}`;
}

function diffSize(repoDir: string, base: string, head: string) {
  const size = { files: 0, additions: 0, deletions: 0 };
  for (const row of git(repoDir, "diff", "--numstat", base, head).split("\n").filter(Boolean)) {
    const [added, removed] = row.split("\t");
    size.files++;
    size.additions += Number(added) || 0;
    size.deletions += Number(removed) || 0;
  }
  return size;
}

function build(locatedPath: string, cleanPath: string, clonesDir: string, casesDir: string): void {
  const located: Located[] = JSON.parse(readFileSync(locatedPath, "utf8"));
  const cleanCandidates: CleanCandidate[] = JSON.parse(readFileSync(cleanPath, "utf8"));
  mkdirSync(casesDir, { recursive: true });
  const write = (key: string, content: object) => {
    const file = path.join(casesDir, `${caseId(key)}.json`);
    writeFileSync(file, `${JSON.stringify({ id: caseId(key), ...content }, null, 2)}\n`);
  };

  for (const key of BUG_CASES) {
    const entries = located.filter((entry) => `${entry.repo}#${entry.intro.number}` === key);
    const intro = entries[0]?.intro;
    if (!intro) throw new Error(`${key} is not in ${locatedPath}`);
    const repo = key.split("#")[0]!;
    const bugs = entries
      .map((entry) => ({
        description: entry.fix.title,
        fix: entry.fix.url,
        locations: LOCATION_OVERRIDES[`${key} fix#${entry.fix.number}`] ?? entry.locations,
      }))
      .filter((bug) => bug.locations.length > 0);
    write(key, {
      kind: "bug",
      preset: presetOf(key),
      title: intro.title,
      repo: `https://github.com/${repo}`,
      pr: intro.url,
      base: intro.base,
      head: intro.head,
      diff: diffSize(path.join(clonesDir, repo.replace("/", "__")), intro.base, intro.head),
      bugs,
    });
  }

  for (const key of CLEAN_CASES) {
    const candidate = cleanCandidates.find((entry) => `${entry.repo}#${entry.pr}` === key);
    if (!candidate) throw new Error(`${key} is not in ${cleanPath}`);
    write(key, {
      kind: "clean",
      preset: presetOf(key),
      title: candidate.title.replace(/ \(#\d+\)$/, ""),
      repo: `https://github.com/${candidate.repo}`,
      pr: `https://github.com/${candidate.repo}/pull/${candidate.pr}`,
      base: candidate.base,
      head: candidate.head,
      diff: diffSize(
        path.join(clonesDir, candidate.repo.replace("/", "__")),
        candidate.base,
        candidate.head,
      ),
      bugs: [],
    });
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "search") await search(args[0]!);
else if (command === "locate") locateAll(args[0]!, args[1]!, args[2]!);
else if (command === "clean") clean(args[0]!, args[1]!);
else if (command === "build")
  build(args[0]!, args[1]!, args[2]!, path.join(import.meta.dirname, "..", "cases"));
else throw new Error("usage: mine.ts search | locate | clean | build (see the header comment)");
