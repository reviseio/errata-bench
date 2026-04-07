npm run generate:corrupted -- \
    --source $1 \
    --issues-per-1000-words 5 \
    --max-words-per-chunk 1000 \
    --concurrency 5 \
    --model openai/gpt-5.4:medium \
    --review-model anthropic/claude-opus-4.6:medium
