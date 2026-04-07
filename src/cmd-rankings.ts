import path from "node:path";

import { getDefaultResultsId } from "./api-config.js";
import { buildResultsPath, readJson } from "./fs.js";
import { buildResultsArtifact, renderResultsAscii } from "./results-artifact.js";
import type { ResultsArtifact } from "./types.js";

type CliOptions = {
  artifactPath: string | null;
  groupId: string;
};

function parseArgs(argv: string[]): CliOptions {
  let artifactPath: string | null = null;
  const defaultGroupId = getDefaultResultsId();
  let groupId = defaultGroupId;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--artifact") {
      artifactPath = argv[index + 1] ?? artifactPath;
      index += 1;
      continue;
    }

    if (argv[index] === "--group-id") {
      groupId = argv[index + 1] ?? groupId;
      index += 1;
      continue;
    }

    if (!argv[index].startsWith("-") && artifactPath == null && groupId === defaultGroupId) {
      groupId = argv[index];
    }
  }

  return { artifactPath, groupId };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const artifactPath =
    options.artifactPath != null
      ? path.resolve(options.artifactPath)
      : buildResultsPath(options.groupId);

  if (!artifactPath) {
    throw new Error("No results artifact found. Run npm run bench first or pass --artifact.");
  }

  const rawArtifact = await readJson<ResultsArtifact>(artifactPath);
  const artifact = buildResultsArtifact(rawArtifact.groupId, rawArtifact.attempts, rawArtifact.createdAt);

  console.log(renderResultsAscii(artifact));
  console.log(`results_artifact=${artifactPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
