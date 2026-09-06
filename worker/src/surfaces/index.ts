// ===========================================================================
// worker/src/surfaces — where a finished thing goes (V6 P1 S4.3).
//
// `surface-router.v1` (router.ts) decides WHERE and in what ORDER, never
// whether: presence picks the card, the merge window collapses one space's
// pending work into one glance, the decay order ranks the rest, a blocked
// kind is filed and never shown, and everything else always reaches the
// panel, the shelf, its space and the timeline.
// ===========================================================================

export {
  autoCloseCard,
  cardLine,
  DECAY_ORDER,
  decayIndex,
  DISMISS_KEY_PREFIX,
  DURABLE_SURFACES,
  forgiveDismissal,
  isNudgeKind,
  kindDismissals,
  kindOfArtifact,
  MAC_ACTIVE_WINDOW_MS,
  macActive,
  markCardShown,
  mergeGroups,
  noteNotNow,
  notNowCard,
  nudgeView,
  openCard,
  peekOf,
  pendingItems,
  routeNow,
  routeSurfaces,
  routerContext,
  shelfDepth,
  SURFACES,
  unreadCount,
  withheldCount,
  wrongGoalCards,
  type CardShown,
  type NudgeView,
  type RoutableItem,
  type RoutedCard,
  type RoutedItemPlan,
  type RoutePlan,
  type RouteReason,
  type RouterContext,
  type Surface,
} from "./router.js";
