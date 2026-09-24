// Hoymiles installer-account automation for TARS Vision Bridge.
// This adapter is intentionally DOM-driven: it uses visible labels/text and
// accessible roles instead of fixed screen coordinates.
(() => {
  if (window.__tarsHoymilesAutomation) return;
  window.__tarsHoymilesAutomation = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = v => String(v || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const norm = v => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

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
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    el.click();
    return true;
  }

  async function waitFor(fn, timeout = 12000, interval = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const value = fn();
        if (value) return value;
      } catch (_) {}
      await sleep(interval);
    }
    throw new Error('Timeout waiting for page element');
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

    // Prefer real interactive controls. The old generic findText() could select
    // a large parent <div> whose text happened to contain the button label,
    // causing .click() to hit the wrong element.
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
    // Prefer the actual navigation/control element. The previous generic text
    // search could land on an inner <span> instead of the clickable <a>, which
    // left the portal on /website/home even though the automation reported a click.
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
    // On the current Hoymiles UI, "Org & User" is an Ant Design horizontal
    // submenu, not a normal link. Clicking its inner .ant-menu-submenu-title
    // opens a popup containing "Org. Management".
    if (location.pathname.includes('/website/base/group')) {
      console.info('[TARS Hoymiles] Org. Management already open');
      return;
    }

    console.info('[TARS Hoymiles] locating Org & User submenu');
    const orgMenu = await waitFor(() => {
      const exact = findInteractiveText('Org & User', { exact: true });
      if (exact) return exact;

      // Exact DOM shape observed on Hoymiles:
      // li.ant-menu-overflow-item.ant-menu-submenu[data-submenu-id="shuju-1"]
      //   > div.ant-menu-submenu-title[data-menu-id="shuju-1"]
      //     > span.ant-menu-title-content = "Org & User"
      // Prefer the stable data-menu-id/data-submenu-id attributes over a
      // text-only scan. Ant Design can render the popup elsewhere in the DOM.
      const byId = allVisible('[data-menu-id="shuju-1"].ant-menu-submenu-title')
        .find(el => norm(el.innerText || el.textContent) === norm('Org & User'));
      if (byId) return byId;

      const scoped = allVisible('li.ant-menu-submenu[data-submenu-id="shuju-1"] > .ant-menu-submenu-title')
        .find(el => norm(el.innerText || el.textContent) === norm('Org & User'));
      return scoped || null;
    }, 15000, 200);

    console.info('[TARS Hoymiles] opening Org & User submenu', orgMenu);
    // Ant Design horizontal submenus are hover-driven. Trigger the same
    // pointer/mouse sequence a real user performs, then click the title as a
    // fallback for versions that also support click-to-open.
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

    // Hoymiles can briefly keep an older drawer/form in the DOM while opening the
    // new one. Prefer an item inside the currently open drawer, then a visible one,
    // then the last match (usually the newest form).
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

    // Hoymiles uses Ant Design TreeSelect here. Do not require the wrapper itself
    // to pass our visibility heuristic: the drawer can animate/portal the control.
    let field = item.querySelector('.ant-tree-select');
    if (!field) {
      // The drawer/form can still be transitioning. Re-resolve the exact label a few
      // times instead of locking onto a stale form item.
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

    // The search input is the real TreeSelect interaction surface. Use focus +
    // native value setter + input/change events so Vue/rc-select receives it.
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

  async function selectTypeInstaller() {
    const item = formItemByLabel('Type');
    if (!item) throw new Error('Could not find Type form item');
    const field = item.querySelector('.ant-select:not(.ant-tree-select)');
    if (!field) throw new Error('Could not find Type selector');

    // Type is intentionally disabled until Parent Organization is selected.
    // Give Vue/Ant Design time to react to the TreeSelect change, and if this
    // standalone test is run first, select the required parent automatically.
    if (field.classList.contains('ant-select-disabled')) {
      console.info('[TARS Hoymiles] Type is disabled; ensuring Parent Organization = APItest');
      await selectAntTreeSelectByText('Parent Organization', 'APItest');
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
    const n = norm(state);
    for (const aliases of Object.values(STATE_ALIASES)) {
      if (aliases.some(a => n === a || n.includes(a))) return aliases;
    }
    return [n];
  }

  async function selectRegionByState(state) {
    const item = formItemByLabel('Region');
    if (!item) throw new Error('Could not find Region form item');
    const field = item.querySelector('.ant-cascader');
    if (!field) throw new Error('Could not find Region selector');

    const wantedState = clean(state);
    const stateNorm = norm(wantedState);
    const aliases = stateTokens(wantedState);
    const currentRaw = field.querySelector('.ant-select-selection-item')?.getAttribute('title') ||
      field.querySelector('.ant-select-selection-item')?.textContent || '';
    const current = norm(currentRaw);
    if (current && aliases.some(t => current === t || current.startsWith(t + ' /') || current.includes(t))) {
      console.info('[TARS Hoymiles] Region already matches state', wantedState, currentRaw);
      return currentRaw;
    }

    console.info('[TARS Hoymiles] opening Region Cascader', {state: wantedState, current: currentRaw});
    click(field.querySelector('.ant-select-selector') || field);
    await sleep(500);

    // IMPORTANT: Hoymiles uses a Cascader. Its menu is virtual/re-rendered, so
    // never retain a generic menu item found by position. Resolve the exact
    // state by its title/text immediately before clicking and then verify it.
    const stateOption = await waitFor(() => {
      const candidates = [...document.querySelectorAll(
        '.ant-cascader-menu-item[role="menuitemcheckbox"], .ant-cascader-menu-item'
      )].filter(visible);
      const exact = candidates.find(el => {
        const title = norm(el.getAttribute('title') || '');
        const text = norm(el.innerText || el.textContent || '');
        return title === stateNorm || text === stateNorm ||
          aliases.some(a => title === a || text === a);
      });
      return exact || null;
    }, 10000, 150);

    if (!stateOption) throw new Error(`Could not find Region state: ${wantedState}`);
    console.info('[TARS Hoymiles] clicking exact Region state', {
      requested: wantedState,
      title: stateOption.getAttribute('title'),
      text: clean(stateOption.innerText || stateOption.textContent || ''),
      pathKey: stateOption.getAttribute('data-path-key')
    });
    click(stateOption);
    await sleep(400);

    // Verify that the first column really selected the requested state before
    // touching the second column. This prevents a stale/virtualized DOM node
    // from causing e.g. Roraima -> Maranhão -> Acre.
    await waitFor(() => {
      const menus = [...document.querySelectorAll('.ant-cascader-menu')].filter(visible);
      if (!menus.length) return null;
      const firstMenu = menus[0];
      const checked = [...firstMenu.querySelectorAll('.ant-cascader-menu-item')].find(el =>
        el.getAttribute('aria-checked') === 'true' &&
        aliases.some(a => norm(el.getAttribute('title') || el.innerText || el.textContent || '') === a)
      );
      return checked || null;
    }, 5000, 150);

    // The second column contains the cities/regions for the selected state.
    // Select the first enabled option from that column, but exclude the state
    // column itself and require that a second menu actually exists.
    const childOption = await waitFor(() => {
      const menus = [...document.querySelectorAll('.ant-cascader-menu')].filter(visible);
      if (menus.length < 2) return null;
      const lastMenu = menus[menus.length - 1];
      const candidates = [...lastMenu.querySelectorAll('.ant-cascader-menu-item')].filter(visible);
      return candidates.find(el =>
        !el.classList.contains('ant-cascader-menu-item-disabled') &&
        el.getAttribute('aria-disabled') !== 'true'
      ) || null;
    }, 10000, 150);

    if (!childOption) throw new Error(`Could not find a Region child for ${wantedState}`);
    console.info('[TARS Hoymiles] clicking first available Region child', {
      state: wantedState,
      title: childOption.getAttribute('title'),
      text: clean(childOption.innerText || childOption.textContent || ''),
      pathKey: childOption.getAttribute('data-path-key')
    });
    click(childOption);
    await sleep(400);

    const finalValue = await waitFor(() => {
      const el = field.querySelector('.ant-select-selection-item');
      const text = clean(el?.getAttribute('title') || el?.textContent || '');
      const n = norm(text);
      return text && aliases.some(a => n === a || n.startsWith(a + ' /')) ? text : null;
    }, 7000, 200);
    console.info('[TARS Hoymiles] Region value confirmed', finalValue);
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
    // First use the normal label/for and nested-control logic.
    const direct = labelElement(labelTerms);
    if (direct) return direct;

    // Hoymiles may render form labels as plain div/span text instead of <label>.
    // Walk upward from the visible text and look for a nearby select/combobox.
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
    console.info('[TARS Hoymiles] STEP 1: opening Org & User / Org. Management');
    await openOrgManagement();
    await sleep(500);
    console.info('[TARS Hoymiles] STEP 2: opening Add Organization');
    await clickButtonText('Add Organization', { exact: true });

    // Do not assume the click changed the route immediately. Wait for the actual
    // Add Organization form/control to appear before touching Parent Organization.
    console.info('[TARS Hoymiles] STEP 2: waiting for Add Organization form');
    const parent = await waitFor(() =>
      findLabeledControl(['parent organization']) || fieldByPlaceholder(['select'])
    );
    console.info('[TARS Hoymiles] STEP 2: Add Organization form detected');

    // Parent Organization is an Ant TreeSelect. Select APItest through the tree
    // option itself and verify the selected chip/value before continuing.
    console.info('[TARS Hoymiles] STEP 3: selecting Parent Organization = APItest');
    await selectAntTreeSelectByText('Parent Organization', 'APItest');

    await fillLabeled(['name'], data.company, ['enter']);
    await selectTypeInstaller();
    // Country is already Brazil in the observed workflow. Only change it if the page
    // exposes a country selector and it is not already Brazil.
    const countryText = findText('Brazil', { exact: true });
    if (!countryText) {
      const country = labelElement(['country']);
      if (country) {
        click(country); await sleep(200);
        const brazil = findText('Brazil', { exact: true }) || findText('Brazil');
        if (brazil) click(brazil);
      }
    }
    await selectRegionByState(data.state);
    await fillLabeled(['contact'], data.email, ['enter']);
    await fillLabeled(['contact number'], data.phone, ['enter']);

    const confirm = await waitFor(() => findButton(['confirm']));
    click(confirm);
    await sleep(800);
    return true;
  }

  async function openOrgUserManagement() {
    // Org. User Management lives in the SAME Ant Design submenu as Org. Management.
    // Use the exact stable submenu id supplied by the live DOM.
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
    console.info('[TARS Hoymiles] STEP 5: opening Org. User Management');
    await openOrgUserManagement();

    // The organization selector is an Ant Tree. Search is the input with the
    // exact placeholder observed in the live DOM.
    const search = await waitFor(() => fieldByPlaceholder(['enter org. name.']), 12000, 150);
    fireInput(search, company);
    await sleep(500);

    // Select the actual tree node, not an ancestor containing the company text.
    const companyNode = await waitFor(() => {
      const titles = allVisible('.ant-tree-title');
      return titles.find(el => norm(el.innerText || el.textContent) === norm(company)) || null;
    }, 12000, 150);

    console.info('[TARS Hoymiles] selecting organization', company);
    const companyWrapper = companyNode.closest('.ant-tree-node-content-wrapper') || companyNode;
    click(companyWrapper);

    // Wait until the right-hand users panel is actually bound to the selected org.
    await waitFor(() => {
      const usersPanel = document.querySelector('.group_user_table');
      const addButton = findButton(['add org. users'], { exact: true });
      return usersPanel && visible(usersPanel) && addButton ? addButton : null;
    }, 12000, 150);

    console.info('[TARS Hoymiles] organization selected; opening Add Org. Users');
    const addUsers = await waitFor(() => findButton(['add org. users'], { exact: true }), 8000, 150);
    click(addUsers);

    // The user drawer has an exact form class in the observed DOM.
    await waitFor(() => document.querySelector('.ant-drawer .editGroupUser'), 10000, 150);
    await sleep(250);
  }

  async function createUser(data) {
    console.info('[TARS Hoymiles] STEP 6: filling Add Org. Users form');

    // Exact field labels from the observed .editGroupUser DOM.
    await fillLabeled(['login email'], data.email, ['enter']);
    console.info('[TARS Hoymiles] Login Email filled');

    await fillLabeled(['password'], data.password, ['enter the password']);
    console.info('[TARS Hoymiles] Password filled');

    await fillLabeled(['name'], data.fullName, ['enter']);
    console.info('[TARS Hoymiles] Name filled');

    await fillLabeled(['contact number'], data.phone, ['enter']);
    console.info('[TARS Hoymiles] Contact Number filled');

    // Role is NOT an input in this form. The supplied DOM explicitly shows
    // Default Role = Installer as a non-editable ant-tag. Verify it rather than
    // trying to click a nonexistent role selector.
    const role = await waitFor(() => {
      const item = formItemByLabel('Default Role');
      const tag = item?.querySelector('.ant-tag');
      const text = clean(tag?.innerText || tag?.textContent || '');
      return norm(text) === norm('Installer') ? text : null;
    }, 7000, 150);
    console.info('[TARS Hoymiles] Default Role verified', role);

    // Confirm is outside the .ant-drawer-body in Ant Design's drawer footer,
    // so search the whole visible drawer, not only the form.
    const drawer = [...document.querySelectorAll('.ant-drawer.ant-drawer-open')].at(-1);
    const confirm = await waitFor(() => {
      const scope = drawer || document;
      const controls = [...scope.querySelectorAll('button, [role="button"]')].filter(visible);
      return controls.find(el => norm(el.innerText || el.textContent) === norm('Confirm')) ||
        controls.find(el => norm(el.innerText || el.textContent).includes(norm('Confirm'))) || null;
    }, 10000, 150);

    console.info('[TARS Hoymiles] STEP 7: confirming new Org User');
    click(confirm);

    // Success is represented by the drawer closing and/or a success notification.
    // Do not require a fragile credentials-dialog selector because its exact DOM
    // was not part of the supplied source.
    await waitFor(() => {
      const openForm = document.querySelector('.ant-drawer.ant-drawer-open .editGroupUser');
      const success = allVisible('.ant-message-success, .ant-notification-notice-success, [role="alert"]')
        .some(el => /success|successful|created|added|succeed/i.test(clean(el.innerText || el.textContent)));
      return !openForm || success ? true : null;
    }, 15000, 200);

    console.info('[TARS Hoymiles] Org User creation completed');
    return true;
  }

  async function run(data) {
    if (location.origin !== 'https://global.hoymiles.com') throw new Error('Not on the Hoymiles portal');
    if (!data?.company || !data?.fullName || !data?.email || !data?.phone || !data?.state) {
      throw new Error('Incomplete Hoymiles account data');
    }
    await createOrganization(data);
    await findOrganizationAndOpenUsers(data.company);
    await createUser({ ...data, password: 'Solar123' });
    return { ok: true, email: data.email, company: data.company };
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
    if (['HOYMILES_TEST_PING','HOYMILES_TEST_INSPECT','HOYMILES_TEST_ORG','HOYMILES_TEST_PARENT','HOYMILES_TEST_ADD_ORG','HOYMILES_TEST_NAME','HOYMILES_TEST_TYPE','HOYMILES_TEST_COUNTRY','HOYMILES_TEST_REGION','HOYMILES_TEST_CONTACT','HOYMILES_TEST_CONTACT_NUMBER','HOYMILES_TEST_ADDRESS','HOYMILES_TEST_INTRO'].includes(msg.type)) {
      runTest(msg.type).then(sendResponse).catch(error => sendResponse({ok:false,error:String(error?.message || error)}));
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
