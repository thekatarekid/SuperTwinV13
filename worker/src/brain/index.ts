// ===========================================================================
// Brain wiki module (Phase 2): markdown knowledge base at ~/SuperTwinV11/brain.
// Re-exports the public surface; see root.ts / writers.ts / markdown.ts.
// ===========================================================================

export { brainRoot, commitBrain, ensureBrain, resetBrainCacheForTests } from "./root.js";
export {
  appendCorrection,
  appendJournal,
  appendPreference,
  appendSpaceLog,
  readBrainFile,
  upsertPatternFile,
  upsertPersonFile,
  upsertSpaceFile,
  type GoalInput,
  type PatternInput,
  type PersonInput,
  type SpaceInput,
  type TaskInput,
} from "./writers.js";
export {
  mergeManagedSections,
  parseFrontmatter,
  serializeFrontmatter,
  slugify,
  upsertMarkdown,
  type Frontmatter,
  type ManagedSection,
} from "./markdown.js";
export { handleBrainRoute } from "./routes.js";
