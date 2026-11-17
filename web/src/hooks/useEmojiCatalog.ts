import { use, useEffect, useState } from "react";
import { loadWithReload } from "@/utils/lazy";

type EmojiCatalog = typeof import("@/lib/emoji");

let catalog: EmojiCatalog | undefined;
let pending: Promise<EmojiCatalog> | undefined;

export const loadEmojiCatalog = () => {
  pending ??= loadWithReload(() => import("@/lib/emoji")).then(
    (module) => (catalog = module),
    (error) => {
      pending = undefined;
      throw error;
    },
  );
  return pending;
};

/** Suspends until the emoji catalog has loaded. */
export const useEmojiCatalog = (): EmojiCatalog => catalog ?? use(loadEmojiCatalog());

/** Returns the emoji's name once the catalog has loaded, and the emoji itself until then. */
export const useEmojiName = (emoji: string) => {
  const [loaded, setLoaded] = useState(catalog);
  useEffect(() => {
    if (!loaded) loadEmojiCatalog().then(setLoaded, () => undefined);
  }, [loaded]);
  return loaded?.emojiName(emoji) ?? emoji;
};
