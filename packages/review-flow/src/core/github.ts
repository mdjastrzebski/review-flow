import { execFile } from "node:child_process";
import { fetchPullRequest, remoteUrls } from "./git.ts";
import type { ReviewPayload } from "./post.ts";

/** A GitHub pull request, as recorded in run.json. */
export interface PullRequest {
  number: number;
  url: string;
  title: string;
  /** GitHub host, such as `github.com` or a GitHub Enterprise host. */
  host: string;
  /** `owner/name` of the base repository. */
  repo: string;
  /** Base branch name, such as `main`. */
  baseBranch: string;
  headSha: string;
  isCrossRepository: boolean;
}

const PR_URL = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** `123`, `#123`, or a PR URL; null for anything else (a branch, commit, or range). */
export function parsePrTarget(target: string): string | null {
  const number = /^#?(\d+)$/.exec(target);
  if (number !== null) return number[1] as string;
  return PR_URL.test(target) ? target : null;
}

/** Runs `gh` and returns stdout; `input` goes to stdin. */
export async function gh(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
      (error, stdout, stderr) => {
        if (error === null) return resolve(stdout);
        const detail = stderr.trim() || error.message;
        reject(
          new Error(
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "gh not found. PR targets need the GitHub CLI: https://cli.github.com"
              : `gh ${args[0]} ${args[1] ?? ""} failed: ${detail}`,
          ),
        );
      },
    );
    child.stdin?.end(input ?? "");
  });
}

interface PrView {
  number: number;
  url: string;
  title: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
}

export async function viewPr(cwd: string, target: string): Promise<PullRequest> {
  const fields = "number,url,title,headRefOid,baseRefName,isCrossRepository";
  const view = JSON.parse(await gh(cwd, ["pr", "view", target, "--json", fields])) as PrView;
  const match = PR_URL.exec(view.url);
  if (match === null) throw new Error(`Unexpected PR URL from gh: ${view.url}`);
  return {
    number: view.number,
    url: view.url,
    title: view.title,
    host: match[1] as string,
    repo: match[2] as string,
    baseBranch: view.baseRefName,
    headSha: view.headRefOid,
    isCrossRepository: view.isCrossRepository,
  };
}

/** `host/owner/name` from a remote URL (https, ssh, or scp-like), lowercased, no `.git`. */
function remoteSlug(url: string): string | null {
  const match = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(
    url.trim(),
  );
  return match === null ? null : `${match[1]}/${match[2]}`.toLowerCase();
}

/** The remote that points at the PR's base repo; `origin` wins a tie. */
export function matchRemote(
  remotes: ReadonlyMap<string, string>,
  pr: Pick<PullRequest, "host" | "repo">,
): string | null {
  const want = `${pr.host}/${pr.repo}`.toLowerCase();
  const names = [...remotes].filter(([, url]) => remoteSlug(url) === want).map(([name]) => name);
  return names.includes("origin") ? "origin" : (names[0] ?? null);
}

export interface FetchedPr {
  pr: PullRequest;
  /** The PR's base branch on the matching remote, freshly fetched, such as `origin/main`. */
  base: string;
}

/** Looks up a PR with gh and fetches its base branch and head commit from the matching remote. */
export async function fetchPr(repo: string, target: string): Promise<FetchedPr> {
  const pr = await viewPr(repo, target);
  const remote = matchRemote(await remoteUrls(repo), pr);
  if (remote === null) {
    throw new Error(`No git remote points at ${pr.host}/${pr.repo}, the repo of PR #${pr.number}.`);
  }
  await fetchPullRequest(repo, remote, pr.number, pr.baseBranch, pr.headSha);
  return { pr, base: `${remote}/${pr.baseBranch}` };
}

export interface PostedReview {
  id: number;
  url: string;
  /** null when reading them back failed; the review was still posted. */
  comments: { id: number; path: string; body: string }[] | null;
}

/**
 * Creates one PR review, then reads back its inline comments for their ids. The read-back is best
 * effort: once the review exists, a failure there must not hide that it was posted.
 */
export async function postReview(
  cwd: string,
  pr: PullRequest,
  payload: ReviewPayload,
): Promise<PostedReview> {
  const endpoint = `repos/${pr.repo}/pulls/${pr.number}/reviews`;
  const api = ["api", "--hostname", pr.host];
  const review = JSON.parse(
    await gh(cwd, [...api, "--method", "POST", endpoint, "--input", "-"], JSON.stringify(payload)),
  ) as { id: number; html_url: string };
  // One page holds them all: a run has at most MAX_FINDINGS (15) findings.
  const comments = await gh(cwd, [...api, `${endpoint}/${review.id}/comments?per_page=100`]).then(
    (out) =>
      (JSON.parse(out) as { id: number; path: string; body: string }[]).map(
        ({ id, path, body }) => ({ id, path, body }),
      ),
    () => null,
  );
  return { id: review.id, url: review.html_url, comments };
}

/** The PR's current head commit. */
export async function currentPrHead(cwd: string, pr: PullRequest): Promise<string> {
  const out = await gh(cwd, ["pr", "view", pr.url, "--json", "headRefOid", "-q", ".headRefOid"]);
  return out.trim();
}
