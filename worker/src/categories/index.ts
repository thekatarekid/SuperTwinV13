// Categories — Cat-1/Cat-2 identification, promotion on engagement (P1.6,
// spec §5.1). Browser per-domain heuristics live with their adapter
// (adapters/browser/category.ts, P0.8); this package holds the chat rules,
// the stream-level backfill, and the engagement promotion path.

export {
  backfillBrowserStreamCategories,
  backfillChatCategories,
  chatCategoryFor,
  type CategoryBackfillReport,
  type ChatCategoryDecision,
  type ChatCategoryFacts,
  type StreamCategory,
} from "./chat.js";
export {
  ENGAGEMENT_HALF_LIFE_DAYS,
  engagementScore,
  noteSelfAuthoredEvents,
  noteUserReply,
  type EngagementReport,
} from "./promotion.js";
