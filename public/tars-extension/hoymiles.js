// Hoymiles installer-account automation for TARS Vision Bridge.
// This adapter is intentionally DOM-driven: it uses visible labels/text and
// accessible roles instead of fixed screen coordinates.
(() => {
  if (window.__tarsHoymilesAutomation) return;
  window.__tarsHoymilesAutomation = true;

  const sleep = ms => new Promise(resolve => {
    if (emergencyStopped) return resolve();
    const started = Date.now();
    const tick = () => {
      if (emergencyStopped || Date.now() - started >= ms) return resolve();
      setTimeout(tick, Math.min(25, ms - (Date.now() - started)));
    };
    setTimeout(tick, Math.min(25, ms));
  });
  const clean = v => String(v || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const norm = v => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  let emergencyStopped = false;
  let automationRunId = 0;

  function assertAutomationRunning() {
    if (emergencyStopped) throw new Error('TARS emergency stop active');
  }

  function stopImmediately(reason = 'user') {
    if (emergencyStopped) return;
    emergencyStopped = true;
    automationRunId++;
    console.warn('[TARS Hoymiles SAFETY] automation stopped immediately', { reason });
  }

  function visible(el) {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  function allVisible(selector) {
    return [...document.querySelectorAll(selector)].filter(visible);
  }

  function fireInput(el, value) {
    assertAutomationRunning();
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function click(el) {
    assertAutomationRunning();
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    el.click();
    return true;
  }

  async function waitFor(fn, timeout = 12000, interval = 150) {
    assertAutomationRunning();
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      assertAutomationRunning();
      try {
        const value = fn();
        if (value) return value;
      } catch (_) {}
      await sleep(interval);
    }
    console.error('[TARS Hoymiles] waitFor timeout', { url: location.href, path: location.pathname, page: getHoymilesPageState?.() || null, visibleControls: [...document.querySelectorAll('a,button,[role=button],[role=menuitem]')].filter(visible).slice(0,40).map(el => clean(el.innerText || el.textContent)).filter(Boolean) });
    throw new Error(`Timeout waiting for page element at ${location.pathname}`);
  }

  function labelElement(labelTerms) {
    const wanted = labelTerms.map(norm);
    const labels = allVisible('label, [class*="label"], [class*="Label"]');
    for (const label of labels) {
      const text = norm(label.innerText || label.textContent);
      if (!text) continue;
      if (!wanted.some(term => text.includes(term))) continue;
      const forId = label.getAttribute('for');
      if (forId) {
        const target = document.getElementById(forId);
        if (target && visible(target)) return target;
      }
      const parent = label.parentElement;
      const nested = parent?.querySelector('input, textarea, [role="combobox"], .ant-select, [class*="select"]');
      if (nested && visible(nested)) return nested;
      const sibling = label.nextElementSibling?.querySelector?.('input, textarea, [role="combobox"], .ant-select, [class*="select"]');
      if (sibling && visible(sibling)) return sibling;
    }
    return null;
  }

  function fieldByPlaceholder(placeholders) {
    const wanted = placeholders.map(norm);
    return allVisible('input, textarea').find(el => {
      const p = norm(el.getAttribute('placeholder'));
      return wanted.some(x => p.includes(x));
    }) || null;
  }

  function findButton(texts, { exact = false } = {}) {
    const wanted = texts.map(norm);
    const selectors = [
      'button',
      '[role="button"]',
      'a',
      '[class*="btn"]',
      '[class*="button"]'
    ];

    for (const selector of selectors) {
      const match = allVisible(selector).find(el => {
        const text = norm(el.innerText || el.textContent);
        return wanted.some(x => exact ? text === x : text.includes(x));
      });
      if (match) return match;
    }
    return null;
  }

  async function clickButtonText(text, options = {}) {
    const el = await waitFor(() => findButton([text], options));
    console.info('[TARS Hoymiles] clicking button', text);
    click(el);
    await sleep(300);
    return el;
  }

  function findText(text, { exact = false } = {}) {
    const wanted = norm(text);
    const candidates = allVisible('button, a, span, div, li, td, p, [role="option"], [role="menuitem"], [role="treeitem"]');
    return candidates.find(el => {
      const t = norm(el.innerText || el.textContent);
      return exact ? t === wanted : t.includes(wanted);
    }) || null;
  }

  async function clickText(text, options) {
    const el = await waitFor(() => findText(text, options));
    click(el);
    await sleep(250);
    return el;
  }

  function findInteractiveText(text, { exact = true } = {}) {
    const wanted = norm(text);
    const selectors = [
      'a',
      'button',
      '[role=button]',
      '[role=menuitem]',
      '[role=link]',
      '.ant-menu-submenu-title'
    ];
    for (const selector of selectors) {
      const match = allVisible(selector).find(el => {
        const t = norm(el.innerText || el.textContent);
        return exact ? t === wanted : t.includes(wanted);
      });
      if (match) return match;
    }
    return null;
  }

  async function clickInteractiveText(text, options = {}) {
    const el = await waitFor(() => findInteractiveText(text, options));
    console.info('[TARS Hoymiles] clicking navigation/control', text);
    click(el);
    await sleep(400);
    return el;
  }

  async function openOrgManagement() {
    if (location.pathname.includes('/website/base/group')) {
      console.info('[TARS Hoymiles] Org. Management already open');
      return;
    }

    console.info('[TARS Hoymiles] locating Org & User submenu');
    const orgMenu = await waitFor(() => {
      const exact = findInteractiveText('Org & User', { exact: true });
      if (exact) return exact;

      const byId = allVisible('[data-menu-id="shuju-1"].ant-menu-submenu-title')
        .find(el => norm(el.innerText || el.textContent) === norm('Org & User'));
      if (byId) return byId;

      const scoped = allVisible('li.ant-menu-submenu[data-submenu-id="shuju-1"] > .ant-menu-submenu-title')
        .find(el => norm(el.innerText || el.textContent) === norm('Org & User'));
      return scoped || null;
    }, 15000, 200);

    console.info('[TARS Hoymiles] opening Org & User submenu', orgMenu);
    orgMenu.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true, cancelable:true, view:window}));
    orgMenu.dispatchEvent(new MouseEvent('mouseover', {bubbles:true, cancelable:true, view:window}));
    await sleep(250);
    orgMenu.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:window}));
    orgMenu.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true, view:window}));
    orgMenu.click();
    await sleep(500);

    console.info('[TARS Hoymiles] waiting for Org. Management submenu item');
    const orgManagement = await waitFor(() => {
      const popup = allVisible('.ant-menu-submenu-popup li[data-menu-id="groupManage"]');
      if (popup.length) return popup[0];
      return findInteractiveText('Org. Management', { exact: true }) ||
        findText('Org. Management', { exact: true }) ||
        findText('Org. Management');
    }, 10000, 150);

    console.info('[TARS Hoymiles] clicking Org. Management', orgManagement);
    click(orgManagement);

    await waitFor(() =>
      location.pathname.includes('/website/base/group') ||
      !!findButton(['Add Organization'], { exact: true })
    , 15000, 200);

    console.info('[TARS Hoymiles] Org. Management page detected', location.href);
  }

  function exactVisibleText(text, selectors = []) {
    const wanted = norm(text);
    const selectorList = selectors.length ? selectors : [
      '[role="option"]', '[role="treeitem"]', '.ant-select-item-option',
      '.ant-select-tree-node-content-wrapper', '.ant-cascader-menu-item', 'li'
    ];
    for (const selector of selectorList) {
      const match = allVisible(selector).find(el => {
        const t = norm(el.innerText || el.textContent);
        const title = norm(el.getAttribute?.('title'));
        return t === wanted || title === wanted;
      });
      if (match) return match;
    }
    return null;
  }

  function setSearchInput(input, value) {
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function formItemByLabel(label) {
    const wanted = norm(label);
    const matches = [...document.querySelectorAll('.editGroup .ant-form-item, .editGroupUser .ant-form-item')].filter(item => {
      const labelEl = item.querySelector('label[title], label');
      return norm(labelEl?.getAttribute('title') || labelEl?.textContent || '') === wanted;
    });
    if (!matches.length) return null;

    const openDrawer = [...document.querySelectorAll('.ant-drawer.ant-drawer-open')].at(-1);
    if (openDrawer) {
      const inOpenDrawer = matches.filter(item => openDrawer.contains(item));
      if (inOpenDrawer.length) return inOpenDrawer.at(-1);
    }
    const visibleMatches = matches.filter(item => {
      const r = item.getBoundingClientRect();
      const cs = getComputedStyle(item);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    });
    return (visibleMatches.length ? visibleMatches : matches).at(-1) || null;
  }

  function formControlByLabel(label) {
    const item = formItemByLabel(label);
    if (!item) return null;
    return item.querySelector(
      'input:not([type="file"]), textarea, .ant-tree-select, .ant-cascader, .ant-select'
    ) || null;
  }

  async function selectAntTreeSelectByText(label, value) {
    const wanted = norm(value);
    const item = formItemByLabel(label);
    if (!item) throw new Error(`Could not find ${label} form item`);

    let field = item.querySelector('.ant-tree-select');
    if (!field) {
      field = await waitFor(() => {
        const freshItem = formItemByLabel(label);
        return freshItem?.querySelector('.ant-tree-select') || null;
      }, 5000, 150);
    }
    if (!field) {
      console.warn('[TARS Hoymiles] TreeSelect field diagnostics', {
        label,
        item: item.outerHTML.slice(0, 3000),
        editGroups: document.querySelectorAll('.editGroup').length,
        treeSelects: document.querySelectorAll('.editGroup .ant-tree-select').length
      });
      throw new Error(`Could not find ${label} TreeSelect`);
    }

    const input = field.querySelector('input.ant-select-selection-search-input[role="combobox"]');
    const selector = field.querySelector('.ant-select-selector') || field;
    console.info('[TARS Hoymiles] TreeSelect target', {
      label,
      value,
      inputId: input?.id || null,
      fieldClass: field.className,
      fieldRect: (() => { const r=field.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()
    });

    click(selector);
    await sleep(500);

    if (input && !input.disabled) {
      input.focus();
      setSearchInput(input, '');
      await sleep(100);
      setSearchInput(input, value);
      input.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', code:'ArrowDown', bubbles:true}));
      await sleep(600);
    }

    const option = await waitFor(() => {
      const selectors = [
        '.ant-select-tree-node-content-wrapper',
        '.ant-select-tree-treenode[role="treeitem"]',
        '[role="treeitem"]',
        '.ant-select-dropdown [role="option"]',
        '.ant-select-dropdown li'
      ];
      for (const selector of selectors) {
        const found = [...document.querySelectorAll(selector)].filter(visible).find(el => {
          const text = norm(el.innerText || el.textContent);
          const title = norm(el.getAttribute('title'));
          return text === wanted || title === wanted;
        });
        if (found) return found;
      }
      return null;
    }, 10000, 150);

    console.info('[TARS Hoymiles] clicking TreeSelect option', option);
    const target = option.matches?.('.ant-select-tree-node-content-wrapper')
      ? option
      : option.querySelector?.('.ant-select-tree-node-content-wrapper') || option;
    click(target);

    await waitFor(() => {
      const selected = field.querySelector('.ant-select-selection-item');
      const text = norm(selected?.getAttribute('title') || selected?.innerText || selected?.textContent || '');
      return text === wanted;
    }, 5000, 150);
    console.info('[TARS Hoymiles] TreeSelect value confirmed', value);
    return value;
  }

  async function selectTypeInstaller(parentOrganization = 'APItest') {
    const item = formItemByLabel('Type');
    if (!item) throw new Error('Could not find Type form item');
    const field = item.querySelector('.ant-select:not(.ant-tree-select)');
    if (!field) throw new Error('Could not find Type selector');

    if (field.classList.contains('ant-select-disabled')) {
      console.info('[TARS Hoymiles] Type is disabled; ensuring configured Parent Organization', parentOrganization);
      await selectAntTreeSelectByText('Parent Organization', parentOrganization);
      await waitFor(() => !field.classList.contains('ant-select-disabled'), 10000, 200);
    }

    console.info('[TARS Hoymiles] opening Type selector', {
      className: field.className,
      ariaExpanded: field.querySelector('[role="combobox"]')?.getAttribute('aria-expanded') || null
    });
    click(field.querySelector('.ant-select-selector') || field);
    await sleep(500);

    const option = await waitFor(() => {
      const candidates = [
        ...document.querySelectorAll('.ant-select-dropdown .ant-select-item-option'),
        ...document.querySelectorAll('.ant-select-dropdown [role="option"]')
      ].filter(visible);
      return candidates.find(el => {
        const t = norm(el.innerText || el.textContent);
        const title = norm(el.getAttribute('title'));
        return t === 'installer' || title === 'installer';
      }) || null;
    }, 10000, 200);

    console.info('[TARS Hoymiles] clicking Type option Installer', option);
    click(option);

    const selected = await waitFor(() => {
      const el = field.querySelector('.ant-select-selection-item');
      const text = norm(el?.getAttribute('title') || el?.innerText || el?.textContent || '');
      return text === 'installer' ? text : null;
    }, 7000, 200);
    console.info('[TARS Hoymiles] Type value confirmed Installer', selected);
    return selected;
  }

  const STATE_ALIASES = {
    acre: ['acre', 'ac'], alagoas: ['alagoas', 'al'], amapá: ['amapa', 'ap'],
    amazonas: ['amazonas', 'am'], bahia: ['bahia', 'ba'], ceará: ['ceara', 'ce'],
    'distrito federal': ['distrito federal', 'df'], 'espírito santo': ['espirito santo', 'es'],
    'goiás': ['goias', 'go'], 'maranhão': ['maranhao', 'ma'], 'mato grosso': ['mato grosso', 'mt'],
    'mato grosso do sul': ['mato grosso do sul', 'ms'], 'minas gerais': ['minas gerais', 'mg'],
    'pará': ['para', 'pa'], 'paraíba': ['paraiba', 'pb'], 'paraná': ['parana', 'pr'],
    pernambuco: ['pernambuco', 'pe'], 'piauí': ['piaui', 'pi'], 'rio de janeiro': ['rio de janeiro', 'rj'],
    'rio grande do norte': ['rio grande do norte', 'rn'], 'rio grande do sul': ['rio grande do sul', 'rs'],
    'rondônia': ['rondonia', 'ro'], roraima: ['roraima', 'rr'], 'santa catarina': ['santa catarina', 'sc'],
    'são paulo': ['sao paulo', 'sp'], sergipe: ['sergipe', 'se'], tocantins: ['tocantins', 'to']
  };

  function stateTokens(state) {
    const n = norm(state).trim();
    for (const aliases of Object.values(STATE_ALIASES)) {
      if (aliases.some(a => norm(a).trim() === n)) return aliases;
    }
    return [n];
  }

  function cascaderMenus() {
    return [...document.querySelectorAll('.ant-cascader-menu')]
      .filter(visible)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.left - br.left || ar.top - br.top;
      });
  }

  function cascaderItems(menu) {
    if (!menu) return [];
    return [...menu.querySelectorAll('.ant-cascader-menu-item')].filter(visible);
  }

  function cascaderItemLabel(el) {
    return clean(el?.getAttribute('title') || el?.innerText || el?.textContent || '');
  }

  function isEnabledCascaderItem(el) {
    return !!el &&
      !el.classList.contains('ant-cascader-menu-item-disabled') &&
      el.getAttribute('aria-disabled') !== 'true';
  }

  async function selectRegionByState(state) {
    const item = formItemByLabel('Region');
    if (!item) throw new Error('Could not find Region form item');
    const field = item.querySelector('.ant-cascader');
    if (!field) throw new Error('Could not find Region selector');

    const wantedState = clean(state);
    const aliases = stateTokens(wantedState);
    const isWanted = value => {
      const n = norm(value).trim();
      return aliases.some(a => n === norm(a).trim());
    };

    const selectedEl = () => field.querySelector('.ant-select-selection-item');
    const selectedText = () => {
      const el = selectedEl();
      return clean(el?.getAttribute('title') || el?.textContent || '');
    };

    const currentRaw = selectedText();
    if (currentRaw && aliases.some(t => {
      const n = norm(currentRaw);
      const a = norm(t);
      return n === a || n.startsWith(a + ' /');
    })) {
      console.info('[TARS Hoymiles] Region already matches state', wantedState, currentRaw);
      return currentRaw;
    }

    console.info('[TARS Hoymiles] opening Region Cascader', {
      state: wantedState,
      current: currentRaw
    });
    click(field.querySelector('.ant-select-selector') || field);
    await sleep(400);

    await waitFor(() => {
      const menus = cascaderMenus();
      if (!menus.length) return null;
      const candidate = cascaderItems(menus[0]).find(el =>
        isEnabledCascaderItem(el) && isWanted(cascaderItemLabel(el))
      );
      return candidate ? cascaderItemLabel(candidate) : null;
    }, 10000, 100);

    let clickedState = false;
    for (let attempt = 0; attempt < 30 && !clickedState; attempt++) {
      const menus = cascaderMenus();
      const firstMenu = menus[0];
      const candidate = firstMenu && cascaderItems(firstMenu).find(el =>
        isEnabledCascaderItem(el) && isWanted(cascaderItemLabel(el))
      );
      const liveLabel = candidate ? cascaderItemLabel(candidate) : '';

      if (candidate && isWanted(liveLabel)) {
        console.info('[TARS Hoymiles] clicking VERIFIED Region state', {
          requested: wantedState,
          liveLabel,
          attempt: attempt + 1
        });
        click(candidate);
        clickedState = true;
        break;
      }
      await sleep(80);
    }

    if (!clickedState) {
      throw new Error(`Could not safely click exact Region state: ${wantedState}`);
    }

    const childReady = await waitFor(() => {
      const menus = cascaderMenus();
      if (menus.length < 2) return null;
      const children = cascaderItems(menus[1]).filter(isEnabledCascaderItem);
      if (!children.length) return null;
      const first = children[0];
      const label = cascaderItemLabel(first);
      return label ? label : null;
    }, 10000, 100);

    console.info('[TARS Hoymiles] first visible Region child located', {
      requested: wantedState,
      child: childReady
    });

    let clickedChild = false;
    for (let attempt = 0; attempt < 30 && !clickedChild; attempt++) {
      const menus = cascaderMenus();
      if (menus.length < 2) {
        await sleep(80);
        continue;
      }

      const children = cascaderItems(menus[1]).filter(isEnabledCascaderItem);
      const child = children[0] || null;
      const liveChildLabel = child ? cascaderItemLabel(child) : '';

      if (child && liveChildLabel) {
        console.info('[TARS Hoymiles] clicking FIRST visible Region child', {
          requested: wantedState,
          child: liveChildLabel,
          attempt: attempt + 1
        });
        click(child);
        clickedChild = true;
        break;
      }
      await sleep(80);
    }

    if (!clickedChild) {
      throw new Error(`Could not select first visible Region child for ${wantedState}`);
    }

    const finalValue = await waitFor(() => {
      const text = selectedText();
      const n = norm(text);
      return text && aliases.some(a => n === a || n.startsWith(a + ' /')) ? text : null;
    }, 7000, 150);

    const finalNorm = norm(finalValue);
    const verified = aliases.some(a => finalNorm === a || finalNorm.startsWith(a + ' /'));
    if (!verified) {
      throw new Error(`Region verification failed: requested ${wantedState}, got ${finalValue}`);
    }

    console.info('[TARS Hoymiles] Region value confirmed', {
      requested: wantedState,
      selected: finalValue,
      child: childReady
    });
    return finalValue;
  }

  async function fillLabeled(labelTerms, value, placeholderTerms = []) {
    let field = null;
    const wanted = labelTerms.map(norm);
    const formItems = [...document.querySelectorAll('.editGroup .ant-form-item, .editGroupUser .ant-form-item')];
    for (const item of formItems) {
      const title = norm(item.querySelector('label')?.getAttribute('title') || '');
      if (!title || !wanted.some(term => title === term)) continue;
      const control = item.querySelector('input:not([type="file"]), textarea, .ant-select, [role="combobox"]');
      if (control && visible(control)) { field = control; break; }
    }
    if (!field) field = labelElement(labelTerms);
    if (!field && placeholderTerms.length) field = fieldByPlaceholder(placeholderTerms);
    if (!field) throw new Error(`Could not find field: ${labelTerms[0]}`);
    if (field.matches?.('[role="combobox"], .ant-select, [class*="select"]') && !field.matches('input')) {
      click(field);
      await sleep(200);
      const input = field.querySelector?.('input') || allVisible('input').find(x => x !== field);
      if (input) fireInput(input, value);
    } else {
      fireInput(field, value);
    }
    await sleep(120);
  }

  async function waitForModalClose(title) {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const visibleTitle = findText(title, { exact: true });
      if (!visibleTitle) return true;
      await sleep(200);
    }
    return false;
  }

  function findLabeledControl(labelTerms) {
    const wanted = labelTerms.map(norm);
    const direct = labelElement(labelTerms);
    if (direct) return direct;

    const texts = allVisible('div, span, p, td').filter(el => {
      const t = norm(el.innerText || el.textContent);
      return wanted.some(term => t === term || t.includes(term));
    });
    for (const textEl of texts) {
      let node = textEl;
      for (let depth = 0; depth < 5 && node; depth++, node = node.parentElement) {
        const control = node.querySelector?.('[role=combobox], input, .ant-select, [class*="select"]');
        if (control && visible(control)) return control;
      }
    }
    return null;
  }

  async function createOrganization(data) {
    assertAutomationRunning();

    const parentOrganization =
      String(data.parentOrganization || 'APItest').trim() || 'APItest';

    console.info('[TARS Hoymiles] STEP 1: opening Org & User / Org. Management');
    await openOrgManagement();

    await sleep(500);

    console.info('[TARS Hoymiles] STEP 2: opening Add Organization');
    await clickButtonText('Add Organization', { exact: true });

    await waitFor(() =>
      findLabeledControl(['parent organization']) ||
      fieldByPlaceholder(['select'])
    );

    console.info(
      '[TARS Hoymiles] STEP 3: selecting Parent Organization',
      parentOrganization
    );

    await selectAntTreeSelectByText(
      'Parent Organization',
      parentOrganization
    );

    await fillLabeled(['name'], data.company, ['enter']);
    await selectTypeInstaller(parentOrganization);

    await fillLabeled(['contact'], data.fullName, ['enter']);
    await fillLabeled(['contact number'], data.phone, ['enter']);
    await selectRegionByState(data.state);

    const confirm = await waitFor(() => findButton(['confirm']));
    click(confirm);

    await waitFor(() => {
      const form = document.querySelector('.editGroup');
      return !form || !visible(form);
    }, 15000, 200);

    console.info(
      '[TARS Hoymiles] Organization successfully created',
      {
        company: data.company,
        parentOrganization
      }
    );

    return true;
  }

  async function openOrgUserManagement() {
    console.info('[TARS Hoymiles] opening Org. User Management from Org & User submenu');

    const orgMenu = await waitFor(() => {
      const byId = allVisible('[data-menu-id="shuju-1"].ant-menu-submenu-title')
        .find(el => norm(el.innerText || el.textContent) === norm('Org & User'));
      if (byId) return byId;
      return allVisible('li.ant-menu-submenu[data-submenu-id="shuju-1"] > .ant-menu-submenu-title')
        .find(el => norm(el.innerText || el.textContent) === norm('Org & User')) || null;
    }, 12000, 150);

    orgMenu.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true, cancelable:true, view:window}));
    orgMenu.dispatchEvent(new MouseEvent('mouseover', {bubbles:true, cancelable:true, view:window}));
    await sleep(250);
    orgMenu.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:window}));
    orgMenu.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true, view:window}));
    orgMenu.click();

    const userManagement = await waitFor(() => {
      const exact = allVisible('.ant-menu-submenu-popup li[data-menu-id="groupUserManage"]')
        .find(el => norm(el.innerText || el.textContent) === norm('Org. User Management'));
      return exact || findInteractiveText('Org. User Management', { exact: true }) || null;
    }, 10000, 150);

    console.info('[TARS Hoymiles] clicking Org. User Management', userManagement);
    click(userManagement);

    await waitFor(() => {
      const search = fieldByPlaceholder(['enter org. name.']);
      return search || location.pathname.includes('/website/base/groupUser');
    }, 15000, 200);
    await sleep(400);
  }

  async function findOrganizationAndOpenUsers(company) {
    assertAutomationRunning();
    console.info('[TARS Hoymiles] STEP 5: opening Org. User Management');
    await openOrgUserManagement();

    const search = await waitFor(() => fieldByPlaceholder(['enter org. name.']), 12000, 150);
    fireInput(search, company);
    await sleep(500);

    const companyNode = await waitFor(() => {
      const titles = allVisible('.ant-tree-title');
      return titles.find(el => norm(el.innerText || el.textContent) === norm(company)) || null;
    }, 12000, 150);

    console.info('[TARS Hoymiles] selecting organization', company);
    const companyWrapper = companyNode.closest('.ant-tree-node-content-wrapper') || companyNode;
    click(companyWrapper);

    await waitFor(() => {
      const usersPanel = document.querySelector('.group_user_table');
      const addButton = findButton(['add org. users'], { exact: true });
      return usersPanel && visible(usersPanel) && addButton ? addButton : null;
    }, 12000, 150);

    console.info('[TARS Hoymiles] organization selected; opening Add Org. Users');
    const addUsers = await waitFor(() => findButton(['add org. users'], { exact: true }), 8000, 150);
    click(addUsers);

    await waitFor(() => document.querySelector('.ant-drawer .editGroupUser'), 10000, 150);
    await sleep(250);
  }

  async function createUser(data) {
    assertAutomationRunning();
    console.info('[TARS Hoymiles] STEP 6: filling Add Org. Users form');

    await fillLabeled(['login email'], data.email, ['enter']);
    console.info('[TARS Hoymiles] Login Email filled');

    await fillLabeled(['password'], data.password, ['enter the password']);
    console.info('[TARS Hoymiles] Password filled');

    await fillLabeled(['name'], data.fullName, ['enter']);
    console.info('[TARS Hoymiles] Name filled');

    await fillLabeled(['contact number'], data.phone, ['enter']);
    console.info('[TARS Hoymiles] Contact Number filled');

    const role = await waitFor(() => {
      const item = formItemByLabel('Default Role');
      const tag = item?.querySelector('.ant-tag');
      const text = clean(tag?.innerText || tag?.textContent || '');
      return norm(text) === norm('Installer') ? text : null;
    }, 7000, 150);
    console.info('[TARS Hoymiles] Default Role verified', role);

    const drawer = [...document.querySelectorAll('.ant-drawer.ant-drawer-open')].at(-1);
    const confirm = await waitFor(() => {
      const scope = drawer || document;
      const controls = [...scope.querySelectorAll('button, [role="button"]')].filter(visible);
      return controls.find(el => norm(el.innerText || el.textContent) === norm('Confirm')) ||
        controls.find(el => norm(el.innerText || el.textContent).includes(norm('Confirm'))) || null;
    }, 10000, 150);

    console.info('[TARS Hoymiles] STEP 7: confirming new Org User');
    click(confirm);

    await waitFor(() => {
      const openForm = document.querySelector('.ant-drawer.ant-drawer-open .editGroupUser');
      const success = allVisible('.ant-message-success, .ant-notification-notice-success, [role="alert"]')
        .some(el => /success|successful|created|added|succeed/i.test(clean(el.innerText || el.textContent)));
      return !openForm || success ? true : null;
    }, 15000, 200);

    console.info('[TARS Hoymiles] Org User creation completed');
    return true;
  }

  function getHoymilesPageState() {
    const path = String(location.pathname || '/');
    const isHome = path === '/website/home' || path === '/website/home/';
    const isOrgUserManagement = path.includes('/website/base/groupUser');
    const isOrgManagement = !isOrgUserManagement && path.includes('/website/base/group');
    const hasPortalNav = !!document.querySelector('.ant-menu, [data-menu-id="shuju-1"], .ant-layout-sider');
    const page = isHome ? 'HOME' : isOrgManagement ? 'ORG_MANAGEMENT' : isOrgUserManagement ? 'ORG_USER_MANAGEMENT' : 'OTHER_HOYMILES_PAGE';
    return { ok: true, page, isHome, isOrgManagement, isOrgUserManagement, hasPortalNav, url: location.href, path };
  }

  function friendlyAutomationError(error, stage) {
    const raw = String(error?.message || error || '');
    if (/Not on the Hoymiles portal/i.test(raw)) return 'Automation stopped because the Hoymiles portal was not open.';
    if (/Incomplete Hoymiles account data/i.test(raw)) return 'Automation stopped because some required customer information is missing.';
    if (/Parent Organization/i.test(raw) && /not found|not selected|confirm/i.test(raw)) return 'Automation stopped because the parent organization could not be selected.';
    if (/contact/i.test(raw) && /not found|mismatch|fill|verify/i.test(raw)) return 'Automation stopped because the organization contact information could not be entered or verified.';
    if (/Timeout waiting/i.test(raw)) return 'Automation stopped because Hoymiles did not show the required screen or field in time.';
    if (/Form item not found|control not found/i.test(raw)) return 'Automation stopped because Hoymiles did not show a required field.';
    if (/ReferenceError|is not defined/i.test(raw)) return 'Automation stopped because one of TARS\'s automation functions is missing. The account was not marked as completed.';
    return `Automation stopped during ${stage || 'the current step'}. TARS could not safely confirm that step was completed.`;
  }

  async function run(data) {
    emergencyStopped = false;
    const runId = ++automationRunId;
    let stage = 'startup';
    try {
      assertAutomationRunning();
      console.info('[TARS Hoymiles] automation run started', { runId });
      if (location.origin !== 'https://global.hoymiles.com') throw new Error('Not on the Hoymiles portal');
      if (!data?.company || !data?.fullName || !data?.email || !data?.phone || !data?.state) {
        throw new Error('Incomplete Hoymiles account data');
      }
      console.info('[TARS Hoymiles] preflight: where am I?', getHoymilesPageState());
      stage = 'creating the organization';
      await createOrganization(data);
      assertAutomationRunning();
      stage = 'opening the organization user management';
      await findOrganizationAndOpenUsers(data.company);
      assertAutomationRunning();
      stage = 'creating the installer user';
      await createUser({ ...data, password: 'Solar123' });
      assertAutomationRunning();
      console.info('[TARS Hoymiles] automation run completed', { runId });
      return { ok: true, email: data.email, company: data.company };
    } catch (error) {
      const result = {
        ok: false,
        error: String(error?.message || error),
        friendlyError: friendlyAutomationError(error, stage),
        stage,
        runId
      };
      console.error('[TARS Hoymiles] automation failed', result);
      return result;
    }
  }

  function interactiveSnapshot() {
    const els = allVisible('a, button, [role="button"], [role="link"], [role="menuitem"]');
    return els.slice(0, 80).map((el, i) => ({
      i,
      tag: el.tagName,
      text: clean(el.innerText || el.textContent).slice(0, 100),
      href: el.getAttribute('href') || null,
      role: el.getAttribute('role') || null,
      aria: el.getAttribute('aria-label') || null,
      cls: String(el.className || '').slice(0, 120)
    }));
  }

  async function testTextField(label, value) {
    const item = formItemByLabel(label);
    if (!item) return {ok:false, error:`Form item not found: ${label}`, url:location.href};
    const input = item.querySelector('input:not([type="file"]), textarea');
    if (!input) return {ok:false, error:`Text control not found: ${label}`, html:item.outerHTML.slice(0,4000)};
    fireInput(input, value);
    await sleep(250);
    const actual = String(input.value || '');
    console.info('[TARS Hoymiles TEST] field filled', {label, expected:value, actual});
    return {ok:actual === value, message:`${label}: ${actual === value ? 'value set and verified' : 'value mismatch'}`, label, expected:value, actual, url:location.href};
  }

  async function testSelectField(label, value, selectorKind='select') {
    const item = formItemByLabel(label);
    if (!item) return {ok:false, error:`Form item not found: ${label}`, url:location.href};
    const field = item.querySelector(selectorKind === 'cascader' ? '.ant-cascader' : '.ant-select:not(.ant-tree-select)');
    if (!field) return {ok:false, error:`Select control not found: ${label}`, html:item.outerHTML.slice(0,4000)};
    console.info('[TARS Hoymiles TEST] select field', {label, value, className:field.className});
    click(field);
    await sleep(500);
    const beforeOptions = [...document.querySelectorAll('.ant-select-dropdown, .ant-cascader-menus, .ant-cascader-menu')]
      .filter(visible)
      .map(el => ({tag:el.tagName, cls:String(el.className||''), text:clean(el.innerText||el.textContent).slice(0,1500)}));

    const option = await waitFor(() => {
      const selectors = selectorKind === 'cascader'
        ? ['.ant-cascader-menu-item', '[role="menuitem"]', 'li']
        : ['.ant-select-item-option', '[role="option"]', 'li'];
      for (const sel of selectors) {
        const found = [...document.querySelectorAll(sel)].filter(visible).find(el => {
          const t=norm(el.innerText||el.textContent); const title=norm(el.getAttribute('title'));
          return t === norm(value) || title === norm(value) || t.includes(norm(value));
        });
        if (found) return found;
      }
      return null;
    }, 7000, 150);

    click(option);
    await sleep(400);
    const selected = field.querySelector('.ant-select-selection-item');
    const actual = clean(selected?.getAttribute('title') || selected?.innerText || selected?.textContent || '');
    console.info('[TARS Hoymiles TEST] select result', {label, expected:value, actual, options:beforeOptions});
    return {ok:norm(actual) === norm(value) || (selectorKind==='cascader' && norm(actual).includes(norm(value))), message:`${label}: ${actual}`, label, expected:value, actual, options:beforeOptions, url:location.href};
  }

  async function runTest(type) {
    console.info('[TARS Hoymiles TEST]', type, location.href);
    if (type === 'HOYMILES_TEST_PING') {
      return {ok:true, message:'Adapter reachable', url:location.href};
    }
    if (type === 'HOYMILES_TEST_INSPECT') {
      const snapshot = interactiveSnapshot();
      console.table(snapshot);
      return {ok:true, url:location.href, count:snapshot.length, controls:snapshot};
    }
    if (type === 'HOYMILES_TEST_ORG') {
      const before = location.href;
      const el = await waitFor(() => {
        const byId = allVisible('[data-menu-id="shuju-1"].ant-menu-submenu-title')
          .find(x => norm(x.innerText || x.textContent) === norm('Org & User'));
        if (byId) return byId;
        const exact = findInteractiveText('Org & User', {exact:true});
        if (exact) return exact;
        return allVisible('li.ant-menu-submenu[data-submenu-id="shuju-1"] > .ant-menu-submenu-title')
          .find(x => norm(x.innerText || x.textContent) === norm('Org & User')) || null;
      }, 15000, 200);
      console.info('[TARS Hoymiles TEST] opening Org & User submenu', el);
      el.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true, cancelable:true, view:window}));
      el.dispatchEvent(new MouseEvent('mouseover', {bubbles:true, cancelable:true, view:window}));
      await sleep(300);
      el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:window}));
      el.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true, view:window}));
      el.click();
      await sleep(600);
      const popupItem = allVisible('.ant-menu-submenu-popup li[data-menu-id="groupManage"]')[0] ||
        findInteractiveText('Org. Management', {exact:true}) || findText('Org. Management', {exact:true});
      if (!popupItem) return {ok:false,error:'Org & User opened, but Org. Management submenu item was not found',before,url:location.href,changed:location.href!==before,controls:interactiveSnapshot()};
      console.info('[TARS Hoymiles TEST] clicking Org. Management', popupItem);
      click(popupItem);
      await sleep(1500);
      return {ok:true,message:'Org & User > Org. Management executed',before,url:location.href,changed:location.href!==before};
    }
    if (type === 'HOYMILES_TEST_PARENT') {
      const form = document.querySelector('.editGroup');
      if (!form) return {ok:false,error:'Add Organization form not found',url:location.href};
      try {
        await selectAntTreeSelectByText('Parent Organization', 'APItest');
        return {ok:true,message:'Parent Organization selected and verified as APItest',url:location.href};
      } catch (error) {
        console.error('[TARS Hoymiles TEST] Parent selector failed', error);
        const item=formItemByLabel('Parent Organization');
        return {ok:false,error:String(error?.message || error),url:location.href, diagnostics:{itemFound:!!item, html:item?.outerHTML?.slice(0,5000)||null}};
      }
    }
    if (type === 'HOYMILES_TEST_NAME') return testTextField('Name', 'TARS Test Organization');
    if (type === 'HOYMILES_TEST_TYPE') {
      try { await selectTypeInstaller(); return {ok:true,message:'Type selected and verified as Installer',url:location.href}; }
      catch (error) { return {ok:false,error:String(error?.message||error),url:location.href}; }
    }
    if (type === 'HOYMILES_TEST_COUNTRY') return testSelectField('Country','Brazil','select');
    if (type === 'HOYMILES_TEST_REGION') {
      try {
        const value = await selectRegionByState('São Paulo');
        return {ok:true,message:`Region selected and verified: ${value}`,url:location.href};
      } catch (error) {
        const item = formItemByLabel('Region');
        return {ok:false,error:String(error?.message||error),url:location.href,diagnostics:{itemFound:!!item,html:item?.outerHTML?.slice(0,6000)||null,menus:[...document.querySelectorAll('.ant-cascader-menu')].map(x=>({visible:visible(x),text:clean(x.innerText||x.textContent).slice(0,2000)}))}};
      }
    }
    if (type === 'HOYMILES_TEST_CONTACT') return testTextField('Contact', 'TARS Test Contact');
    if (type === 'HOYMILES_TEST_CONTACT_NUMBER') return testTextField('Contact Number', '11999999999');
    if (type === 'HOYMILES_TEST_ADDRESS') return testTextField('Address', 'TARS Test Address');
    if (type === 'HOYMILES_TEST_INTRO') return testTextField('Organization Introduction', 'TARS Vision Bridge test');
    if (type === 'HOYMILES_TEST_ADD_ORG') {
      const before = location.href;
      const el = findButton(['Add Organization'], {exact:true});
      if (!el) return {ok:false,error:'Add Organization control not found',url:before,controls:interactiveSnapshot()};
      console.info('[TARS Hoymiles TEST] clicking Add Organization', el);
      click(el);
      await sleep(1000);
      const parent = findLabeledControl(['parent organization']);
      return {ok:true,message:'Add Organization click executed',before,url:location.href,changed:location.href!==before,formDetected:!!parent};
    }
    return {ok:false,error:'Unknown Hoymiles test'};
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'TARS_EMERGENCY_STOP') {
      stopImmediately('background');
      console.warn('[TARS Hoymiles SAFETY] EMERGENCY STOP received; current run will abort and no further actions will execute');
      sendResponse({ ok: true, stopped: true });
      return true;
    }
    if (['HOYMILES_TEST_PING','HOYMILES_TEST_INSPECT','HOYMILES_TEST_ORG','HOYMILES_TEST_PARENT','HOYMILES_TEST_ADD_ORG','HOYMILES_TEST_NAME','HOYMILES_TEST_TYPE','HOYMILES_TEST_COUNTRY','HOYMILES_TEST_REGION','HOYMILES_TEST_CONTACT','HOYMILES_TEST_CONTACT_NUMBER','HOYMILES_TEST_ADDRESS','HOYMILES_TEST_INTRO'].includes(msg.type)) {
      runTest(msg.type).then(sendResponse).catch(error => sendResponse({ok:false,error:String(error?.message || error)}));
      return true;
    }
    if (msg.type === 'HOYMILES_PREFLIGHT') {
      sendResponse(getHoymilesPageState());
      return true;
    }
    if (msg.type === 'HOYMILES_RUN_INSTALLER') {
      run(msg.data)
        .then(result => sendResponse(result))
        .catch(error => {
          console.error('[TARS Hoymiles] automation failed', error);
          sendResponse({ ok: false, error: String(error?.message || error) });
        });
      return true;
    }
    if (msg.type === 'HOYMILES_PING') {
      sendResponse({ ok: true, ready: true, url: location.href });
      return true;
    }
  });

  console.info('[TARS Hoymiles] automation adapter loaded', location.href);
})();
