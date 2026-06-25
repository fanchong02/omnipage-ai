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
        tag === 'header' ||
        tag === 'footer' ||
        role === 'navigation' ||
        role === 'menu' ||
        role === 'menubar' ||
        /sidebar|side-bar|sidenav|side-nav|navbar|nav-bar|menu|drawer|layout-sider|ant-menu|el-menu|bottom-nav|tab-bar|tabbar/.test(
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

  const isExternalHref = href =>
    /^(mailto:|tel:|javascript:|#)/i.test(href) || href === '';

  const results = [];
  const seen = new Set();

  const collect = (el, href, clickOnly) => {
    if (!clickOnly && isExternalHref(href)) return;

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

  const hrefOf = el =>
    el.getAttribute('href') ??
    el.getAttribute('to') ??
    el.getAttribute('data-path') ??
    el.getAttribute('data-href') ??
    el.getAttribute('data-url') ??
    el.getAttribute('data-route') ??
    el.href ??
    '';

  document
    .querySelectorAll(
      'a[href], [href][role="link"], [href][role="menuitem"], [to], [data-path], [data-href], [data-url], [data-route]'
    )
    .forEach(el => {
      collect(el, hrefOf(el), false);
    });

  document.querySelectorAll('[role="link"], [role="menuitem"], [role="tab"]').forEach(el => {
    const href = hrefOf(el);
    if (href && !isExternalHref(href)) return;
    const label = labelOf(el);
    if (!label) return;
    collect(el, '', true);
  });

  return results;
})()
