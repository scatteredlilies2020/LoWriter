// Only host-independent upstream modules are imported. No SillyTavern globals,
// storage backend, credentials, network clients or schedulers are loaded.
// @ts-expect-error Vendored JavaScript has no TypeScript declarations.
export { mergeExtraction, worldCounts } from '../vendor/continuity/memory-model.js';
// @ts-expect-error Vendored JavaScript has no TypeScript declarations.
export { buildMemoryPrompt } from '../vendor/continuity/retrieval.js';
// @ts-expect-error Vendored JavaScript has no TypeScript declarations.
export { alignWorldToChat, collectFingerprintMessages, fingerprintMessage } from '../vendor/continuity/message-digest.js';
// @ts-expect-error Vendored JavaScript has no TypeScript declarations.
export { extractionSchema, assertCompleteExtractionRecords, EXTRACTION_FIELD_GUIDE, EXTRACTION_OUTPUT_CHECK } from '../vendor/continuity/extraction-contract.js';
// @ts-expect-error Vendored JavaScript has no TypeScript declarations.
export { formatExtractionMessages, authoritativeMetaBoundaries, assertAuthoritativeMetaProvenance, precedingUserAttributionContext } from '../vendor/continuity/extraction-context.js';
// @ts-expect-error Vendored JavaScript has no TypeScript declarations.
export { DEFAULT_EXTRACTION_SYSTEM_PROMPT } from '../vendor/continuity/prompts.js';
// @ts-expect-error Vendored JavaScript has no TypeScript declarations.
export { sanitizeReconciliationMetadata, applySourceAttributionFailClosed } from '../vendor/continuity/reconciliation-policy.js';
// @ts-expect-error Vendored JavaScript has no TypeScript declarations.
export { captureScenarioContext } from '../vendor/continuity/scenario-context.js';
