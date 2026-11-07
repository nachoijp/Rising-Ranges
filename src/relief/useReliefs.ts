import { useEffect, useState } from "react";
import { Relief } from "./relief";
// Measured with every door a way through (see doorCut.ts).
import { cutDoors } from "./doorCut";
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
            next.set(image, cutDoors(new Relief(data)));
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
