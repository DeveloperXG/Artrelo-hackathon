/**
 * Inside a .lichen scope, swap a legacy translucent focus ring for the solid
 * Lichen outline (FocusVisibleSolid). For controls that set their own
 * `focus-visible:outline-none ring-…` and are shared with un-migrated light
 * pages, which keep their legacy ring unchanged.
 */
export const LICHEN_FOCUS =
  'lichen:focus-visible:outline-solid lichen:focus-visible:outline-2 lichen:focus-visible:outline-offset-2 lichen:focus-visible:outline-ring lichen:focus-visible:ring-0';
