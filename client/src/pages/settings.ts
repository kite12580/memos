// The settings page: the language picker and the tag rules editor. Section
// switching runs inline in the page so the right section shows at once.

import { $, $$, fromTemplate, post } from "../lib/dom";
import { icon } from "../lib/icon";
import { closeAll, openPopup } from "../lib/popup";
import { toast, toastError } from "../lib/toast";

const root = $("[data-page=settings]")!;

async function setPref(key: string, value: string) {
  try {
    await post("/prefs", { key, value });
    location.reload();
  } catch (e) {
    toastError(e);
  }
}

function initLanguage() {
  const group = $("[data-language]", root)!;
  const input = $<HTMLInputElement>("input", group)!;
  const template = group.parentElement!.querySelector<HTMLTemplateElement>("template[data-languages]")!;
  const current = input.value;
  let popup: HTMLElement | null = null;
  let highlighted = -1;
  const options = () => $$("[role=option]", popup!).filter((o) => !o.hidden);
  const highlight = (i: number) => {
    options().forEach((o, j) => o.toggleAttribute("data-highlighted", j === i));
    highlighted = i;
    options()[i]?.scrollIntoView({ block: "nearest" });
  };
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    const all = q && input.value !== current;
    for (const o of $$("[role=option]", popup!)) o.hidden = !!all && !o.textContent!.toLowerCase().includes(q);
    highlight(options().findIndex((o) => o.hasAttribute("data-selected") || all));
  };
  const open = () => {
    if (popup) return;
    popup = document.createElement("div");
    popup.className = "mu-combobox-popup mu-popup mu-popup-motion mu-base mu-s-md";
    popup.setAttribute("role", "presentation");
    popup.innerHTML = `<div role="status" aria-live="polite" class="mu-combobox-empty mu-body"></div><div role="listbox" tabindex="-1" class="mu-combobox-list"></div>`;
    popup.lastElementChild!.setAttribute("aria-label", input.getAttribute("aria-label")!);
    popup.lastElementChild!.append(template.content.cloneNode(true));
    popup.addEventListener("pointerdown", (e) => e.preventDefault());
    popup.addEventListener("click", (e) => {
      const option = (e.target as HTMLElement).closest<HTMLElement>("[data-lang]");
      if (option) void setPref("lang", option.dataset.lang!);
    });
    const positioner = openPopup(group, popup, "bottom", "start", () => {
      popup = null;
      input.value = current;
      input.setAttribute("aria-expanded", "false");
      group.removeAttribute("data-popup-open");
    });
    positioner.style.setProperty("--anchor-width", `${group.offsetWidth}px`);
    input.setAttribute("aria-expanded", "true");
    input.focus();
    input.select();
    filter();
  };
  group.addEventListener("click", () => popup || open());
  input.addEventListener("input", () => (popup ? filter() : open()));
  input.addEventListener("keydown", (e) => {
    if (!popup) {
      if (e.key === "ArrowDown" || e.key === "Enter") open();
      return;
    }
    const all = options();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      highlight(Math.min(all.length - 1, Math.max(0, highlighted + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && all[highlighted]) {
      e.preventDefault();
      e.stopPropagation();
      void setPref("lang", all[highlighted].dataset.lang!);
    }
  });
  input.addEventListener("blur", () => setTimeout(() => document.activeElement !== input && popup && closeAll(), 0));
}

interface Rule {
  color: string;
  blur: boolean;
}

function setChecked(box: HTMLElement, on: boolean) {
  box.toggleAttribute("data-checked", on);
  box.toggleAttribute("data-unchecked", !on);
  box.setAttribute("aria-checked", String(on));
  box.innerHTML = on ? `<span data-checked="" class="mu-checkbox-indicator">${icon("check", "")}</span>` : "";
}

const setDisabled = (el: HTMLElement, off: boolean) => {
  (el as HTMLButtonElement).disabled = off;
  el.toggleAttribute("data-disabled", off);
};

function initTags() {
  const section = $("[data-tags]", root)!;
  const list = $("[data-rules]", section)!;
  const name = $<HTMLInputElement>("[data-new-tag]", section)!;
  const newColor = $<HTMLInputElement>("[data-new-color]", section)!;
  const newClear = $("[data-new-clear]", section)!;
  const newBlur = $("[data-new-blur]", section)!;
  const add = $("[data-add]", section)!;
  const save = $("[data-save-tags]", root)!;
  const original = new Map<string, Rule>();
  let pickedColor = "";
  const rows = () => $$("[data-rule]", list);
  const state = (row: HTMLElement): Rule => ({ color: row.dataset.color!, blur: row.dataset.blur === "true" });
  for (const row of rows()) original.set(row.dataset.rule!, state(row));

  const changed = () => {
    const now = new Map(rows().map((r) => [r.dataset.rule!, state(r)]));
    if (now.size !== original.size) return true;
    for (const [tag, rule] of now) {
      const was = original.get(tag);
      if (!was || was.color !== rule.color || was.blur !== rule.blur) return true;
    }
    return false;
  };
  const refresh = () => {
    const n = rows().length;
    list.hidden = n === 0;
    $("[data-no-rules]", section)!.hidden = n > 0;
    $("[data-rule-count]", section)!.textContent = String(n);
    setDisabled(save, !changed());
  };
  const paint = (row: HTMLElement) => {
    const color = row.dataset.color!;
    const swatch = $("[data-swatch]", row)!;
    swatch.style.backgroundColor = color || "#ffffff";
    swatch.classList.toggle("bg-mu-canvas", !color);
    $<HTMLInputElement>("[data-rule-color]", row)!.value = color || "#ffffff";
    const clear = $("[data-rule-clear]", row)!;
    $(".mu-button-label", clear)!.textContent = color || section.dataset.default!;
    setDisabled(clear, !color);
    setChecked($("[data-rule-blur]", row)!, row.dataset.blur === "true");
  };

  name.addEventListener("input", () => {
    setDisabled(add, !name.value.trim());
    $("[data-new-field]", section)!.removeAttribute("data-invalid");
    $("[data-new-error]", section)?.remove();
  });
  name.addEventListener("keydown", (e) => e.key === "Enter" && add.click());
  newColor.addEventListener("input", () => {
    pickedColor = newColor.value;
    setDisabled(newClear, false);
  });
  newClear.addEventListener("click", () => {
    pickedColor = "";
    newColor.value = "#ffffff";
    setDisabled(newClear, true);
  });
  add.addEventListener("click", () => {
    const tag = name.value.trim().replace(/^#/, "");
    if (!tag) return;
    if (rows().some((r) => r.dataset.rule === tag)) {
      const field = $("[data-new-field]", section)!;
      field.setAttribute("data-invalid", "");
      if (!$("[data-new-error]", field)) {
        const error = document.createElement("div");
        error.className = "mu-field-error mu-caption";
        error.dataset.newError = "";
        error.textContent = section.dataset.exists!;
        field.append(error);
      }
      return;
    }
    const row = fromTemplate("tpl-tag-rule")!.firstElementChild as HTMLElement;
    row.dataset.rule = tag;
    row.dataset.color = pickedColor;
    row.dataset.blur = String(newBlur.getAttribute("aria-checked") === "true");
    $("[data-rule-name]", row)!.textContent = tag;
    const used = $$<HTMLOptionElement>("#known-tags option", section).find((o) => o.value === tag)?.dataset.used;
    if (used) $("[data-rule-count]", row)!.textContent = used;
    paint(row);
    const after = rows().find((r) => r.dataset.rule! > tag);
    if (after) after.before(row);
    else list.append(row);
    name.value = "";
    setDisabled(add, true);
    newClear.click();
    setChecked(newBlur, false);
    refresh();
  });

  section.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const box = t.closest<HTMLElement>("[role=checkbox]");
    if (box && box === newBlur) return setChecked(box, box.getAttribute("aria-checked") !== "true");
    const row = t.closest<HTMLElement>("[data-rule]");
    if (!row) return;
    if (box) {
      row.dataset.blur = String(row.dataset.blur !== "true");
      e.preventDefault();
    } else if (t.closest("[data-rule-clear]")) row.dataset.color = "";
    else if (t.closest("[data-rule-delete]")) {
      row.remove();
      return refresh();
    } else return;
    paint(row);
    refresh();
  });
  section.addEventListener("keydown", (e) => {
    const box = (e.target as HTMLElement).closest<HTMLElement>("[role=checkbox]");
    if (box && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      box.click();
    }
  });
  section.addEventListener("input", (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>("[data-rule-color]");
    const row = input?.closest<HTMLElement>("[data-rule]");
    if (!input || !row) return;
    row.dataset.color = input.value;
    paint(row);
    refresh();
  });

  save.addEventListener("click", async () => {
    const now = new Map(rows().map((r) => [r.dataset.rule!, state(r)]));
    const writes: [string, Rule][] = [];
    for (const [tag, rule] of now) {
      const was = original.get(tag);
      if (!was || was.color !== rule.color || was.blur !== rule.blur) writes.push([tag, rule]);
    }
    for (const tag of original.keys()) if (!now.has(tag)) writes.push([tag, { color: "", blur: false }]);
    try {
      for (const [tag, rule] of writes) await post("/tags", { tag, ...rule });
      sessionStorage.setItem("toast", section.dataset.saved!);
      location.reload();
    } catch (e) {
      toastError(e);
    }
  });
}

initLanguage();
initTags();
$("[data-refresh]", root)?.addEventListener("click", () => location.reload());
const flash = sessionStorage.getItem("toast");
if (flash) {
  sessionStorage.removeItem("toast");
  toast(flash);
}
