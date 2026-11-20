// The views page: the create and edit form, the row menu, and the icon picker.

import { $, $$, post, reload } from "../lib/dom";
import { icon } from "../lib/icon";
import { closeAll, closeDialog, isOpenFor, listNav, openDialog, openTemplate } from "../lib/popup";
import { toast, toastError } from "../lib/toast";

export default function init(signal: AbortSignal) {
  const root = $("[data-page=views]")!;
  const s = root.dataset as Record<string, string>;
  const form = $("[data-form]", root)!;
  const grid = $("[data-grid]", root)!;
  const guide = $("[data-guide]", root)!;
  const list = $("[data-list]", root)!;
  const toggle = $("[data-toggle-form]", root)!;
  const title = $<HTMLInputElement>("#view-title", root)!;
  const filter = $<HTMLTextAreaElement>("#view-filter", root)!;
  const picker = $("[data-icon-picker]", root)!;
  const rows = () => $$("[data-view]", root);

  let editing: number | null = null;
  let open = false;

  function setIcon(value: string) {
    picker.dataset.value = value;
    const lucide = value.startsWith("lucide:") ? value.slice(7) : "";
    picker.innerHTML = lucide
      ? icon(lucide, "mu-icon shrink-0 size-5 text-xl")
      : value
        ? `<span aria-hidden="true" class="mu-icon inline-flex shrink-0 items-center justify-center size-5 text-xl"></span>`
        : icon("parentheses", "mu-icon shrink-0 size-5 text-xl");
    if (value && !lucide) picker.firstElementChild!.textContent = value;
  }

  function setOpen(next: boolean) {
    open = next;
    form.inert = !next;
    form.classList.toggle("max-h-[48rem]", next);
    form.classList.toggle("opacity-100", next);
    form.classList.toggle("max-h-0", !next);
    form.classList.toggle("border-transparent", !next);
    form.classList.toggle("opacity-0", !next);
    grid.classList.toggle("xl:grid-cols-[minmax(0,1fr)_20rem]", next);
    guide.hidden = !next;
    list.hidden = next && rows().length === 0;
    toggle.innerHTML = `${icon(next ? "x" : "plus", "")}<span class="mu-button-label">${next ? s.cancel : s.create}</span>`;
    if (next) title.focus({ preventScroll: true });
  }

  function fill(draft: { id: number | null; name: string; icon: string; query: string }) {
    editing = draft.id;
    title.value = draft.name;
    filter.value = draft.query;
    setIcon(draft.icon);
    $("[data-form-title]", form)!.textContent = editing === null ? s.createTitle : s.editTitle;
  }

  function openCreate() {
    fill({ id: null, name: "", icon: "", query: "" });
    setOpen(true);
  }

  function close() {
    fill({ id: null, name: "", icon: "", query: "" });
    setOpen(false);
  }

  function valid() {
    if (title.value.trim() && filter.value.trim()) return true;
    toast(s.required, "error");
    return false;
  }

  async function save() {
    if (!valid()) return;
    try {
      await post("/views", { id: editing ?? undefined, name: title.value.trim(), icon: picker.dataset.value ?? "", query: filter.value.trim() });
      sessionStorage.setItem("toast", editing === null ? s.created : s.updated);
      location.replace(location.pathname);
    } catch (e) {
      toastError(e);
    }
  }

  function confirmDelete(row: HTMLElement) {
    const name = row.dataset.name!;
    openDialog("tpl-confirm", (dialog) => {
      $("[data-slot=title]", dialog)!.textContent = s.deleteConfirm.replace("{{title}}", name);
      $("[data-slot=description]", dialog)!.remove();
      $("[data-action=dialog-ok]", dialog)!.addEventListener("click", async () => {
        closeDialog(dialog);
        try {
          await post(`/views/${row.dataset.view}/delete`);
          sessionStorage.setItem("toast", s.deleted.replace("{{title}}", name));
          reload();
        } catch (e) {
          toastError(e);
        }
      });
    });
  }

  async function move(row: HTMLElement, by: number) {
    const ids = rows().map((r) => Number(r.dataset.view));
    const at = ids.indexOf(Number(row.dataset.view));
    const to = at + by;
    if (to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    try {
      await post("/views/order", { ids });
      reload();
    } catch (e) {
      toastError(e);
    }
  }

  function openRowMenu(trigger: HTMLElement) {
    const row = trigger.closest<HTMLElement>("[data-view]")!;
    openTemplate(trigger, "tpl-view-menu", "bottom", "end", (menu) => {
      const index = rows().indexOf(row);
      $("[data-view-action=up]", menu)!.hidden = index === 0;
      $("[data-view-action=down]", menu)!.hidden = index === rows().length - 1;
      menu.addEventListener("click", (e) => {
        const action = (e.target as HTMLElement).closest<HTMLElement>("[data-view-action]")?.dataset.viewAction;
        if (!action) return;
        closeAll();
        if (action === "edit") {
          fill({ id: Number(row.dataset.view), name: row.dataset.name!, icon: row.dataset.icon!, query: row.dataset.query! });
          setOpen(true);
          form.scrollIntoView({ block: "nearest" });
        } else if (action === "delete") confirmDelete(row);
        else void move(row, action === "up" ? -1 : 1);
      });
    });
  }

  const EMOJI: [string, string][] = [
    ["🌱", "Seedling plant garden growth"], ["📚", "Books reading library"], ["💼", "Briefcase work business"], ["🏠", "House home family"],
    ["💡", "Light bulb ideas"], ["🚀", "Rocket launch project"], ["🎨", "Artist palette design art"], ["✍️", "Writing hand journal"],
    ["📝", "Memo notes writing"], ["🧠", "Brain learning knowledge"], ["🎯", "Target goals"], ["⭐", "Star favorites"],
    ["❤️", "Heart love"], ["🔥", "Fire energy"], ["⚡", "Lightning bolt power"], ["☀️", "Sun sunshine"],
    ["🌙", "Moon night"], ["🌈", "Rainbow colors"], ["🌊", "Wave ocean water"], ["🍀", "Four leaf clover luck"],
    ["🌸", "Cherry blossom flower"], ["🌻", "Sunflower"], ["🌳", "Tree forest nature"], ["🍄", "Mushroom"],
    ["🐈", "Cat pet"], ["🐕", "Dog pet"], ["🦊", "Fox"], ["🐼", "Panda"],
    ["🦋", "Butterfly"], ["🐝", "Bee honey"], ["🐙", "Octopus"], ["🐳", "Whale"],
    ["☕", "Coffee drink cafe"], ["🍵", "Tea cup"], ["🍎", "Apple fruit food"], ["🍋", "Lemon fruit"],
    ["🥑", "Avocado"], ["🍕", "Pizza cooking food"], ["🍰", "Cake dessert baking"], ["🍷", "Wine glass"],
    ["🎵", "Music note"], ["🎸", "Guitar music"], ["🎬", "Clapper board movies film"], ["📷", "Camera photography"],
    ["🎮", "Game controller gaming"], ["🎲", "Dice games"], ["⚽", "Soccer football sport"], ["🏀", "Basketball sport"],
    ["🚲", "Bicycle cycling"], ["🏆", "Trophy achievement"], ["✈️", "Airplane travel"], ["🏕️", "Camping tent outdoors"],
    ["🏔️", "Mountain hiking"], ["🏖️", "Beach holiday"], ["🌍", "Earth world globe"], ["🧭", "Compass exploration"],
    ["🔬", "Microscope research science"], ["🧪", "Test tube experiment"], ["💻", "Laptop code technology"], ["🛠️", "Tools building"],
    ["🧩", "Puzzle piece"], ["💎", "Gem diamond"], ["🎓", "Graduation education study"], ["🎉", "Party celebration"],
  ];

  const emojiCell = (emoji: string, label: string) => {
    const cell = document.createElement("div");
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("aria-selected", "false");
    cell.setAttribute("aria-label", label);
    cell.title = label;
    cell.className = "mu-combobox-item";
    cell.dataset.icon = emoji;
    cell.innerHTML = '<span class="mu-combobox-item-text"><span aria-hidden="true" class="mu-icon inline-flex shrink-0 items-center justify-center size-5 text-xl"></span></span><span class="mu-combobox-indicator"></span>';
    cell.querySelector(".mu-icon")!.textContent = emoji;
    return cell;
  };

  /** A single emoji, as typed or pasted into the search. */
  const isEmoji = (text: string) => /^\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*$/u.test(text);

  function openPicker() {
    const popup = openTemplate(picker, "tpl-icon-picker", "bottom", "start");
    if (!popup) return;
    const search = $<HTMLInputElement>("[data-search]", popup)!;
    const gridEl = $("[role=grid]", popup)!;
    const iconCells = $$("[data-icon]", gridEl);
    const empty = $("[role=status]", popup)!;
    const reset = $("[data-reset]", popup)!;
    const tabs = $$("[data-tab]", popup);
    const indicator = $(".mu-tabs-indicator", popup)!;
    const value = picker.dataset.value ?? "";
    let tab = value && !value.startsWith("lucide:") ? "emoji" : "icons";
    reset.classList.toggle("invisible", !value);
    const cells = () => $$("[data-icon]", gridEl).filter((c) => !c.hidden);

    const render = () => {
      const q = search.value.trim().toLowerCase();
      let items: HTMLElement[];
      if (tab === "icons") items = iconCells.filter((c) => c.title.toLowerCase().includes(q) || c.dataset.icon!.includes(q));
      else {
        const custom = search.value.trim() || (value.startsWith("lucide:") ? "" : value);
        const list = EMOJI.filter(([e, label]) => label.toLowerCase().includes(q) || e.includes(q));
        items = list.map(([e, label]) => emojiCell(e, label));
        if (isEmoji(custom) && !list.some(([e]) => e === custom)) items.unshift(emojiCell(custom, s.useEmoji.replace("{{emoji}}", custom)));
      }
      for (const cell of items) cell.setAttribute("aria-selected", String(cell.dataset.icon === value));
      const rowsEl: HTMLElement[] = [];
      for (let i = 0; i < items.length; i += 8) {
        const row = document.createElement("div");
        row.setAttribute("role", "row");
        row.className = "mu-combobox-row";
        row.append(...items.slice(i, i + 8));
        rowsEl.push(row);
      }
      gridEl.replaceChildren(...rowsEl);
      empty.textContent = items.length ? "" : empty.dataset.empty!;
      nav.highlight(search.value ? items[0] : undefined);
    };

    const setTab = (next: string) => {
      tab = next;
      search.value = "";
      for (const t of tabs) {
        const on = t.dataset.tab === tab;
        t.toggleAttribute("data-active", on);
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        if (on) {
          indicator.style.setProperty("--active-tab-left", `${t.offsetLeft}px`);
          indicator.style.setProperty("--active-tab-width", `${t.offsetWidth}px`);
        }
      }
      const label = tab === "icons" ? search.dataset.iconsLabel! : search.dataset.emojiLabel!;
      search.placeholder = label;
      search.setAttribute("aria-label", label);
      gridEl.setAttribute("aria-label", tabs.find((t) => t.dataset.tab === tab)!.textContent!);
      $("[data-emoji-help]", popup)!.classList.toggle("invisible", tab === "icons");
      render();
    };

    const choose = (v: string) => {
      setIcon(v);
      closeAll();
      picker.focus();
    };
    const nav = listNav(gridEl, search, cells, (c) => c && choose(c.dataset.icon!), { steps: { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 8, ArrowUp: -8 } });

    popup.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const tabEl = t.closest<HTMLElement>("[data-tab]");
      if (tabEl) return setTab(tabEl.dataset.tab!);
      if (t.closest("[data-reset]")) return choose("");
      const cell = t.closest<HTMLElement>("[data-icon]");
      if (cell) choose(cell.dataset.icon!);
    });
    search.addEventListener("input", render);
    requestAnimationFrame(() => {
      setTab(tab);
      search.focus();
    });
  }

  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-toggle-form]")) return open ? close() : openCreate();
    if (t.closest("[data-open-form]")) return openCreate();
    if (t.closest("[data-validate]")) return void (valid() && toast(s.valid));
    if (t.closest("[data-save]")) return void save();
    const menu = t.closest<HTMLElement>("[data-view-menu]");
    if (menu) return isOpenFor(menu) ? closeAll() : openRowMenu(menu);
    const iconButton = t.closest<HTMLElement>("[data-icon-picker]");
    if (iconButton) return isOpenFor(iconButton) ? closeAll() : openPicker();
    const example = t.closest<HTMLElement>("[data-example]");
    if (example) {
      if (!title.value.trim()) title.value = example.dataset.title!;
      filter.value = example.dataset.example!;
      setOpen(true);
    }
  });

  const fromHash = () => {
    if (location.hash === "#new") {
      openCreate();
      history.replaceState(null, "", location.pathname);
    }
  };
  addEventListener("hashchange", fromHash, { signal });
  fromHash();
}
