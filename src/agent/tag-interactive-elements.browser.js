(() => {
  document.querySelectorAll('[data-qa-explore-id]').forEach(node => {
    node.removeAttribute('data-qa-explore-id');
  });

  const backLabel = label =>
    /^\s*back\s*$/i.test(label) ||
    /^返回$/.test(label) ||
    /go\s*back/i.test(label) ||
    /^←/.test(label);

  const isTopChrome = el => {
    let node = el;
    while (node) {
      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute('role') ?? '';
      const cls = (node.className?.toString() ?? '').toLowerCase();
      if (
        tag === 'header' ||
        role === 'banner' ||
        /header|navbar|nav-bar|title-bar|topbar|app-bar|page-header|top-bar/.test(cls)
      ) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  };

  const isBottomChrome = (el, rect) => {
    let node = el;
    while (node) {
      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute('role') ?? '';
      const cls = (node.className?.toString() ?? '').toLowerCase();
      if (
        tag === 'footer' ||
        role === 'tablist' ||
        /bottom-nav|tab-bar|tabbar|footer-nav|mobile-tab|dock|navbar-bottom|bottom-bar/.test(cls)
      ) {
        return true;
      }
      node = node.parentElement;
    }
    const role = el.getAttribute('role') ?? '';
    if (role === 'tab' || el.closest('[role="tablist"]')) {
      return rect.top > window.innerHeight * 0.78;
    }
    return rect.top > window.innerHeight * 0.88;
  };

  const isHeaderBackButton = (el, label, rect) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') ?? '';
    const inHeader = isTopChrome(el);
    const topArea = rect.top < 88;

    if (backLabel(label) && (inHeader || topArea)) return true;

    if (!inHeader && !topArea) return false;
    if (tag !== 'button' && tag !== 'a' && role !== 'button') return false;

    const hasIcon = Boolean(
      el.querySelector('svg, img, [class*="icon"], [class*="chevron"], [class*="arrow"]')
    );
    const iconClass = /arrow|chevron|back|left/i.test(el.className?.toString() ?? '');

    return backLabel(label) || ((!label || label === tag) && (hasIcon || iconClass));
  };

  const selector =
    'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="switch"], [role="menuitem"]';
  const nodes = Array.from(document.querySelectorAll(selector));
  const results = [];
  const seen = new Set();

  nodes.forEach((node, index) => {
    const el = node;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;

    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;

    const tag = el.tagName.toLowerCase();
    const inputType = tag === 'input' ? el.type || 'text' : undefined;
    const name =
      el.getAttribute('aria-label')?.trim() ||
      el.innerText?.trim().replace(/\s+/g, ' ').slice(0, 80) ||
      el.getAttribute('placeholder')?.trim() ||
      el.getAttribute('title')?.trim() ||
      el.getAttribute('name')?.trim() ||
      '';

    const dedupeKey = `${tag}:${inputType ?? ''}:${name}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const inChrome = isTopChrome(el) || isBottomChrome(el, rect);
    const id = `el-${index}`;
    el.setAttribute('data-qa-explore-id', id);
    results.push({
      id,
      role: el.getAttribute('role') || tag,
      name: name || inputType || tag,
      tag,
      inputType,
      href: tag === 'a' ? el.href : undefined,
      disabled:
        Boolean(el.disabled) ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.getAttribute('disabled') !== null,
      headerBack: isHeaderBackButton(el, name, rect),
      inChrome,
    });
  });

  return results;
})()
