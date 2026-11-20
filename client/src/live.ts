const bound = new WeakSet<Element>();

export function bind(badge: HTMLElement, e: Event) {
  if (bound.has(badge)) return;
  bound.add(badge);
  const host = badge.closest<HTMLElement>("[data-motion]")!;
  const video = badge.parentElement!.querySelector("video")!;
  let active = false;
  const show = (on: boolean) => video.classList.replace(on ? "opacity-0" : "opacity-100", on ? "opacity-100" : "opacity-0");
  const rewind = () => {
    if (video.readyState >= 1) video.currentTime = Number(host.dataset.pts ?? 0) / 1e6;
  };
  const stop = () => {
    video.pause();
    rewind();
    show(false);
  };
  const play = async (on: boolean) => {
    active = on;
    if (!on) return stop();
    if (!video.src) {
      video.muted = true;
      video.src = host.dataset.motion!;
    }
    rewind();
    try {
      await video.play();
      show(active);
    } catch {
      show(false);
    }
  };
  const touch = (ev: Event) => (ev as PointerEvent).pointerType !== "mouse";
  video.addEventListener("loadedmetadata", rewind);
  video.addEventListener("ended", stop);
  badge.addEventListener("mouseenter", () => play(true));
  badge.addEventListener("mouseleave", () => play(false));
  badge.addEventListener("focus", () => play(true));
  badge.addEventListener("blur", () => play(false));
  badge.addEventListener("pointercancel", () => play(false));
  for (const [type, on] of [["pointerdown", true], ["pointerup", false]] as const) {
    badge.addEventListener(type, (ev) => {
      ev.stopPropagation();
      if (touch(ev)) void play(on);
    });
  }
  badge.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    ev.stopPropagation();
    void play(!active);
  });
  const now = e.type === "pointerover" ? !touch(e) && badge.matches(":hover") : e.type === "pointerdown" ? touch(e) : document.activeElement === badge;
  if (now) void play(true);
}
