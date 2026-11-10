let draft;
export function openTest(root, rule) {
  draft = rule ? structuredClone(rule) : undefined;
  window.location.hash = testRoute(root);
}
export function takeTestRule() {
  const rule = draft;
  draft = undefined;
  return rule;
}
export const testRoute = (root) => `#/test${root ? `?root=${encodeURIComponent(root)}` : ''}`;
