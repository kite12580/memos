/** A Lucide icon from the page's sprite, as the server's `h::icon` writes it. */
export const icon = (name: string, cls: string) =>
  `<svg class="lucide lucide-${name}${cls ? ` ${cls}` : ""}" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="${document.body.dataset.sprite}#i-${name}"/></svg>`;
