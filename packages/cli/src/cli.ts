import { writeFile } from "node:fs/promises";
import { Command, Option } from "commander";
import {
  createRunDir,
  diffAgainstBase,
  ensureGitignored,
  HARNESSES,
  resolveCommit,
  resolveModels,
  resolveRepoRoot,
  shortSha,
  snapshotStatus,
  type Harness,
  type ModelChoice,
} from "@review-flow/core";

interface ReviewOptions {
  base: string;
  harness: Harness;
  model?: string;
  verifierModel?: string;
  cursorBin: string;
  repo: string;
}

function describeModel({ model, effort }: ModelChoice): string {
  const name = model ?? "harness default";
  return effort === null ? name : `${name} (effort: ${effort})`;
}

async function review(options: ReviewOptions): Promise<void> {
  const models = resolveModels(options.harness, {
    model: options.model ?? null,
    verifierModel: options.verifierModel ?? null,
  });
  const repo = await resolveRepoRoot(options.repo);
  await resolveCommit(repo, options.base);

  const diff = await diffAgainstBase(repo, options.base);
  if (diff.trim() === "") {
    throw new Error(`No changes between ${options.base} and HEAD.`);
  }

  if (await ensureGitignored(repo)) {
    console.log("Added .review-flow/ to .gitignore");
  }
  // Taken after the .gitignore edit; agents must leave the tree exactly like this.
  const status = await snapshotStatus(repo);

  const runDir = await createRunDir(repo, await shortSha(repo, "HEAD"), new Date());
  await writeFile(runDir.diffPath, diff);
  console.log(`Run dir: ${runDir.root}`);
  console.log(`Reviewer: ${describeModel(models.reviewer)}`);
  console.log(`Verifier: ${describeModel(models.verifier)}`);

  // Review and verification land in later steps.
  void status;
}

const program = new Command("review-flow");

program
  .command("review")
  .description("Review the current branch against a base ref")
  .requiredOption("--base <ref>", "base ref to diff against (merge-base...HEAD)")
  .addOption(
    new Option("--harness <name>", "agent harness").choices(HARNESSES).makeOptionMandatory(),
  )
  .option("--model <id>", "model for the reviewer (and verifier, unless overridden)")
  .option("--verifier-model <id>", "model for the verifiers")
  .option("--cursor-bin <path>", "Cursor agent CLI binary", "agent")
  .option("--repo <path>", "repository to review", process.env.INIT_CWD ?? process.cwd())
  .action(review);

try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
