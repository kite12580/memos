// The settings page: the language picker, the account and server dialogs and the tag rules editor. Section
// switching runs inline in the page so the right section shows at once.

import { $, $$, fromTemplate, post, reload } from "../lib/dom";
import { icon } from "../lib/icon";
import { closeAll, type ListNav, listNav, openDialog, openPopup } from "../lib/popup";
import { toastError } from "../lib/toast";

export default function init(_signal: AbortSignal) {
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
    let nav: ListNav | null = null;
    const options = () => $$("[role=option]", popup!).filter((o) => !o.hidden);
    const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
    const named = (code: string, lang: string) => {
      try {
        return new Intl.DisplayNames([lang], { type: "language" }).of(code) ?? "";
      } catch {
        return "";
      }
    };
    const labels = (o: HTMLElement) =>
      (o.dataset.search ??= fold([o.textContent, named(o.dataset.lang!, "en"), named(o.dataset.lang!, document.documentElement.lang)].join("\n")));
    const filter = () => {
      const q = fold(input.value.trim());
      const all = q && input.value !== current;
      for (const o of $$("[role=option]", popup!)) o.hidden = !!all && !labels(o).includes(q);
      const empty = popup!.firstElementChild!;
      empty.replaceChildren();
      if (!options().length) {
        const link = document.createElement("a");
        link.className = "mu-link mu-focus";
        link.href = group.dataset.feedback!;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = group.dataset.feedbackLabel!;
        empty.append(link);
      }
      nav!.highlight(options().find((o) => o.hasAttribute("data-selected") || all));
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
      const closed = new AbortController();
      nav = listNav(popup.lastElementChild as HTMLElement, input, options, (o) => o && void setPref("lang", o.dataset.lang!), { signal: closed.signal });
      const positioner = openPopup(group, popup, "bottom", "start", () => {
        closed.abort();
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
      if (!popup && (e.key === "ArrowDown" || e.key === "Enter")) open();
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

  function validPattern(pattern: string) {
    try {
      new RegExp(pattern);
    } catch {
      return false;
    }
    return !/\((?:[^()]*[*+?{][^()]*)\)[*+?{]/.test(pattern);
  }

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
      const problem = rows().some((r) => r.dataset.rule === tag)
        ? section.dataset.exists!
        : !validPattern(tag)
          ? section.dataset.invalidRegex!
          : "";
      if (problem) {
        const field = $("[data-new-field]", section)!;
        field.setAttribute("data-invalid", "");
        $("[data-new-error]", field)?.remove();
        const error = document.createElement("div");
        error.className = "mu-field-error mu-caption";
        error.dataset.newError = "";
        error.textContent = problem;
        field.append(error);
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
      const box = t.closest<HTMLElement>("[role=checkbox]") ?? t.closest("label")?.querySelector<HTMLElement>("[role=checkbox]");
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
        reload();
      } catch (e) {
        toastError(e);
      }
    });
  }

  function setFieldError(field: HTMLElement, message?: string) {
    field.toggleAttribute("data-invalid", !!message);
    $("[data-field-error]", field)?.remove();
    if (!message) return;
    const error = document.createElement("div");
    error.className = "mu-field-error mu-caption";
    error.dataset.fieldError = "";
    error.textContent = message;
    field.append(error);
  }

  async function saveProfile(button: HTMLButtonElement, body: Record<string, string>) {
    button.disabled = true;
    button.setAttribute("data-disabled", "");
    try {
      await post("/profile", body);
      sessionStorage.setItem("toast", $("[data-tags]", root)!.dataset.saved!);
      reload();
    } catch (e) {
      toastError(e);
      button.disabled = false;
      button.removeAttribute("data-disabled");
    }
  }

  const MAX_AVATAR = 2 * 1024 * 1024;
  const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

  /** The picked image as a data URL, re-encoded as PNG when the server would not take its type. */
  async function avatarURL(file: File): Promise<string> {
    let blob: Blob = file;
    if (!AVATAR_TYPES.includes(file.type)) {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      blob = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error())), "image/png"));
    }
    if (blob.size > MAX_AVATAR) throw new RangeError();
    return new Promise((ok, fail) => {
      const reader = new FileReader();
      reader.onload = () => ok(reader.result as string);
      reader.onerror = () => fail(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function editAccount(dialog: HTMLElement) {
    const field = $("[data-avatar-field]", dialog)!;
    const label = $("label", field)!;
    const file = $<HTMLInputElement>("input[type=file]", field)!;
    const clear = $<HTMLButtonElement>("[data-clear-avatar]", field)!;
    const blank = $<HTMLTemplateElement>("template[data-blank-avatar]", field)!;
    let avatar: string | undefined;
    const show = (src: string) => {
      const picture = src ? document.createElement("div") : (blank.content.firstElementChild!.cloneNode(true) as HTMLElement);
      if (src) {
        picture.className = "flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-mu-line w-10 h-10";
        picture.innerHTML = '<img class="size-full object-cover" alt="">';
        picture.querySelector("img")!.src = src;
      }
      label.firstElementChild!.replaceWith(picture);
      clear.hidden = !src;
    };
    file.addEventListener("change", async () => {
      const picked = file.files?.[0];
      file.value = "";
      if (!picked) return;
      if (picked.size > MAX_AVATAR) return setFieldError(field, field.dataset.tooLarge);
      try {
        avatar = await avatarURL(picked);
        setFieldError(field);
        show(avatar);
      } catch (e) {
        setFieldError(field, e instanceof RangeError ? field.dataset.tooLarge : field.dataset.unreadable);
      }
    });
    clear.addEventListener("click", () => {
      avatar = "";
      setFieldError(field);
      show("");
    });
    const nickname = $<HTMLInputElement>("input[name=nickname]", dialog)!;
    $<HTMLButtonElement>("[data-save]", dialog)!.addEventListener("click", (e) =>
      saveProfile(e.currentTarget as HTMLButtonElement, { nickname: nickname.value, ...(avatar === undefined ? {} : { avatar }) }),
    );
  }

  function customizeServer(dialog: HTMLElement) {
    const input = (name: string) => $<HTMLInputElement | HTMLTextAreaElement>(`[name=${name}]`, dialog)!;
    const title = input("title");
    title.addEventListener("input", () => setFieldError($("[data-title-field]", dialog)!));
    $("[data-restore]", dialog)!.addEventListener("click", () => {
      title.value = "Memos";
      input("logo").value = "";
      input("description").value = "";
    });
    $<HTMLButtonElement>("[data-save]", dialog)!.addEventListener("click", (e) => {
      if (!title.value.trim()) return setFieldError($("[data-title-field]", dialog)!, "Title cannot be empty.");
      void saveProfile(e.currentTarget as HTMLButtonElement, {
        title: title.value,
        logo: input("logo").value,
        description: input("description").value,
      });
    });
  }

  initLanguage();
  initTags();
  $("[data-edit-account]", root)!.addEventListener("click", () => openDialog("tpl-account", editAccount));
  $("[data-edit-profile]", root)!.addEventListener("click", () => openDialog("tpl-customize", customizeServer));
  $("[data-refresh]", root)?.addEventListener("click", () => reload());
}
