/**
 * The page's dropdowns (the Vistazo's controls, the relief editor's) open a
 * list of our own instead of the browser's: drawn in the page, glass like the
 * panel, the extension's scrollbar, as the settings' menus look. The
 * `<select>` is still the dropdown: it keeps the value, what reads it and its
 * change event, screen readers, and the arrows changing it while closed. Only
 * the list it opens is ours. Set up once (enhanceSelects), it covers every
 * select on the page, those made later too.
 */

let open: { select: HTMLSelectElement; menu: HTMLElement; active: number; close: () => void } | null = null;

/** From then on, every select on the page opens our list. Before any other keydown listener (see onKey). */
export function enhanceSelects() {
  const take = (event: Event) => {
    const select = (event.target as Element | null)?.closest?.("select");
    if (!select || select.disabled || select.multiple) {
      return;
    }
    // The browser's own list not opened.
    event.preventDefault();
    if (event.type !== "mousedown") {
      return;
    }
    if (open?.select === select) {
      open.close();
    } else {
      select.focus({ preventScroll: true });
      openList(select);
    }
  };
  document.addEventListener("mousedown", take, true);
  // A touch screen's opens on the tap's end.
  document.addEventListener("touchend", (event) => {
    const select = (event.target as Element | null)?.closest?.("select");
    if (select && !select.disabled && !select.multiple) {
      event.preventDefault();
      if (open?.select !== select) {
        select.focus({ preventScroll: true });
        openList(select);
      }
    }
  });
  document.addEventListener("keydown", onKey, true);
  // A press anywhere else, the page resized or scrolled under it: closed.
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (open && !open.menu.contains(event.target as Node) && event.target !== open.select) {
        open.close();
      }
    },
    true
  );
  window.addEventListener("resize", () => open?.close());
  document.addEventListener("scroll", (event) => {
    if (open && !open.menu.contains(event.target as Node)) {
      open.close();
    }
  }, true);
}

/**
 * The keys: on a closed select, Enter, Space, Alt+↓/↑ or F4 open its list (the arrows alone still
 * change it, as the browser's); with the list open, the arrows, Home/End and a letter move in it,
 * Enter or Space picks, Esc or Tab closes. Taken before anything else hears them (the editor's
 * shortcuts, the Vistazo's Esc).
 */
function onKey(event: KeyboardEvent) {
  if (!open) {
    const select = event.target instanceof HTMLSelectElement ? event.target : null;
    if (!select || select.disabled || select.multiple) {
      return;
    }
    const opens = event.key === "Enter" || event.key === " " || event.key === "F4" || (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp"));
    if (opens) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openList(select);
    }
    return;
  }
  const { select } = open;
  const options = [...select.options];
  const move = (to: number) => {
    // Past those that can't be picked, that way.
    const step = to >= open!.active ? 1 : -1;
    let i = Math.max(0, Math.min(options.length - 1, to));
    while (options[i]?.disabled && i + step >= 0 && i + step < options.length) {
      i += step;
    }
    if (!options[i]?.disabled) {
      setActive(i);
    }
  };
  let handled = true;
  switch (event.key) {
    case "ArrowDown":
      move(open.active + 1);
      break;
    case "ArrowUp":
      move(open.active - 1);
      break;
    case "Home":
      move(0);
      break;
    case "End":
      move(options.length - 1);
      break;
    case "Enter":
    case " ":
      choose(open.active);
      break;
    case "Escape":
      open.close();
      break;
    case "Tab":
      open.close();
      handled = false;
      break;
    default:
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // The next one starting with that letter.
        const letter = event.key.toLocaleLowerCase();
        for (let k = 1; k <= options.length; k++) {
          const i = (open.active + k) % options.length;
          if (!options[i].disabled && options[i].text.trim().toLocaleLowerCase().startsWith(letter)) {
            setActive(i);
            break;
          }
        }
      } else {
        handled = false;
      }
  }
  if (handled) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

/** The option the keys are on (highlighted, read out), scrolled into sight. */
function setActive(i: number) {
  if (!open) {
    return;
  }
  open.active = i;
  for (const item of open.menu.children) {
    item.classList.toggle("active", Number((item as HTMLElement).dataset.i) === i);
  }
  const item = open.menu.querySelector<HTMLElement>(`[data-i="${i}"]`);
  if (item) {
    open.select.setAttribute("aria-activedescendant", item.id);
    item.scrollIntoView({ block: "nearest" });
  }
}

/** An option picked: the select's value, told as the browser tells it (input, then change), the list closed. */
function choose(i: number) {
  if (!open) {
    return;
  }
  const { select } = open;
  const option = select.options[i];
  open.close();
  if (!option || option.disabled || select.selectedIndex === i) {
    return;
  }
  select.selectedIndex = i;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

let ids = 0;

/** A select's list, under it (or over it, if there's more room there), at least as wide as it, scrolling if long. */
function openList(select: HTMLSelectElement) {
  open?.close();
  const menu = document.createElement("div");
  menu.className = "dd-menu";
  menu.setAttribute("role", "listbox");
  menu.id = `dd-${++ids}`;
  const label = select.getAttribute("aria-label") ?? select.labels?.[0]?.textContent?.trim();
  if (label) {
    menu.setAttribute("aria-label", label);
  }
  [...select.options].forEach((option, i) => {
    const item = document.createElement("div");
    item.className = "dd-item";
    item.id = `${menu.id}-${i}`;
    item.dataset.i = String(i);
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(i === select.selectedIndex));
    if (option.disabled) {
      item.setAttribute("aria-disabled", "true");
    }
    item.textContent = option.text;
    menu.append(item);
  });
  menu.onpointermove = (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(".dd-item");
    if (item && item.getAttribute("aria-disabled") !== "true" && Number(item.dataset.i) !== open?.active) {
      setActive(Number(item.dataset.i));
    }
  };
  menu.onclick = (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(".dd-item");
    if (item && item.getAttribute("aria-disabled") !== "true") {
      choose(Number(item.dataset.i));
      select.focus({ preventScroll: true });
    }
  };
  // Pressing in it doesn't take the focus from the select (its keys go on working).
  menu.onmousedown = (event) => event.preventDefault();
  document.body.append(menu);

  // Where: below if it fits (or there's more room below), above otherwise.
  const gap = 4;
  const margin = 6;
  const r = select.getBoundingClientRect();
  const [vw, vh] = [document.documentElement.clientWidth, document.documentElement.clientHeight];
  const below = vh - r.bottom - gap - margin;
  const above = r.top - gap - margin;
  const width = Math.min(vw - 2 * margin, Math.max(r.width, menu.offsetWidth));
  menu.style.minWidth = `${width}px`;
  const down = menu.scrollHeight <= below || below >= above;
  menu.style.maxHeight = `${Math.max(80, down ? below : above)}px`;
  const height = menu.offsetHeight;
  menu.style.top = `${down ? r.bottom + gap : r.top - gap - height}px`;
  // Its right edge at the select's when it'd go past the page's (the panel's dropdowns sit at the right).
  const left = r.left + menu.offsetWidth > vw - margin ? r.right - menu.offsetWidth : r.left;
  menu.style.left = `${Math.max(margin, left)}px`;

  select.setAttribute("aria-expanded", "true");
  select.setAttribute("aria-controls", menu.id);
  const close = () => {
    menu.remove();
    select.removeAttribute("aria-activedescendant");
    select.setAttribute("aria-expanded", "false");
    if (open?.menu === menu) {
      open = null;
    }
  };
  open = { select, menu, active: select.selectedIndex, close };
  menu.querySelector(`[data-i="${select.selectedIndex}"]`)?.classList.add("chosen");
  setActive(Math.max(0, select.selectedIndex));
  // The chosen one in the middle of a long list, not at its edge.
  const chosen = menu.querySelector<HTMLElement>(".chosen");
  if (chosen && menu.scrollHeight > menu.clientHeight) {
    menu.scrollTop = chosen.offsetTop - (menu.clientHeight - chosen.offsetHeight) / 2;
  }
}
