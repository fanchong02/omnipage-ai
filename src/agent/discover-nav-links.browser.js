(() => {
  const inNavArea = el => {
    let node = el;
    while (node) {
      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute('role') ?? '';
      const cls = (node.className?.toString() ?? '').toLowerCase();
      if (
        tag === 'nav' ||
        tag === 'aside' ||
        role === 'navigation' ||
        role === 'menu' ||
        /sidebar|side-bar|sidenav|side-nav|navbar|nav-bar|menu|drawer|layout-sider|ant-menu|el-menu/.test(
          cls
        )
      ) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  };

  const labelOf = el =>
    (
      el.getAttribute('aria-label') ??
      el.getAttribute('title') ??
      el.innerText ??
      ''
    )
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);

  const results = [];
  const seen = new Set();

  const collect = (el, href, clickOnly) => {
    if (!clickOnly && (!href || href === '#' || href.startsWith('javascript:'))) return;

    const label = labelOf(el);
    const key = `${clickOnly ? 'click' : href}::${label}`;
    if (seen.has(key)) return;
    seen.add(key);

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    if (el.getAttribute('aria-disabled') === 'true' || el.disabled) return;

    results.push({
      href: href || label,
      label: label || href,
      inNav: inNavArea(el),
      clickOnly,
    });
  };

  document
    .querySelectorAll('a[href], [href][role="link"], [href][role="menuitem"], [to], [data-path]')
    .forEach(el => {
      const href =
        el.getAttribute('href') ??
        el.getAttribute('to') ??
        el.getAttribute('data-path') ??
        el.href ??
        '';
      collect(el, href, false);
    });

  document.querySelectorAll('[role="link"], [role="menuitem"], [role="tab"]').forEach(el => {
    const href =
      el.getAttribute('href') ??
      el.getAttribute('to') ??
      el.getAttribute('data-path') ??
      el.href ??
      '';
    if (href && href !== '#') return;
    collect(el, '', true);
  });

  return results;
})()
