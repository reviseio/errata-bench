import dotenv from "dotenv";

import { getApiProvider } from "./api-config.js";
import { getModelPricing, getPricingCachePath, refreshPricingCache } from "./pricing.js";

dotenv.config();

type CliOptions = {
  help: boolean;
  model: string | null;
};

function parseArgs(argv: string[]): CliOptions {
  let help = false;
  let model: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--help" || argv[index] === "-h") {
      help = true;
      continue;
    }

    if (argv[index] === "--model") {
      model = argv[index + 1] ?? model;
      index += 1;
    }
  }

  return { help, model };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log("Usage: npm run pricing:refresh -- [--model <model-id>]");
    console.log("Forces a fresh pricing pull from the OpenRouter /models API.");
    return;
  }

  const prices = await refreshPricingCache();

  console.log(`provider=${getApiProvider()}`);
  console.log(`cache=${getPricingCachePath()}`);
  console.log(`models=${Object.keys(prices).length}`);

  if (!options.model) {
    return;
  }

  const pricing = await getModelPricing(options.model);

  if (!pricing) {
    throw new Error(`Model "${options.model}" was not found in the refreshed pricing index.`);
  }

  console.log(`model=${options.model}`);
  console.log(`input_usd_per_token=${pricing.inputUsdPerToken}`);
  console.log(`output_usd_per_token=${pricing.outputUsdPerToken}`);
  console.log(`source=${pricing.source}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
