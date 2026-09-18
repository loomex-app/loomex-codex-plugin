/** Prevent superseded implementations from returning through bundled inputs. */
export function checkRetiredUiPaths(inputs, browserCode, template) {
  const retired = /(?:^|\/)(?:runtime-legacy\.(?:js|d\.ts)|view-persistence\.js)$/;
  const failures = inputs.filter(path => retired.test(path)).map(path => `Retired browser implementation: ${path}`);
  if (/ui-tooltip|tooltipCloseTimer|deferTooltipClose/.test(browserCode) || /class=["']tooltip["']|\.tooltip\s*\{/.test(template)) {
    failures.push('Retired tooltip implementation is present in packaged UI');
  }
  return failures;
}
