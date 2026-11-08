import { useEffect, useState } from "react";
import { Relief } from "./relief";
import { watchReliefs } from "./store";

/** This window's reliefs, from the background (see store.ts), kept up to date. */
export function useReliefs(): Map<string, Relief> {
  const [reliefs, setReliefs] = useState(() => new Map<string, Relief>());
  useEffect(
    () =>
      watchReliefs((image, data) =>
        setReliefs((before) => {
          const next = new Map(before);
          if (data) {
            // As it is: its doors cut once it's stacked (see measure.ts).
            next.set(image, new Relief(data));
          } else {
            next.delete(image);
          }
          return next;
        })
      ),
    []
  );
  return reliefs;
}
