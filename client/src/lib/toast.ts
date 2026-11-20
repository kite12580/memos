// Loaded on demand so it stays out of the first page's script budget.
const view = () => import("./toast-view");

export const toast = (message: string, type?: "success" | "danger") => void view().then((m) => m.toast(message, type));

export const toastError = (e: unknown) => void view().then((m) => m.toastError(e));
