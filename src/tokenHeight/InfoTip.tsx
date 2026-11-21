import { useEffect, useRef, useState } from "react";

/**
 * A section's "i" and its hint, as the settings' and the Vistazo's: shown on
 * the pointer, on keyboard focus, or tapped open (on touch there's no
 * pointer over it). Under its title, or over it when the menu's bottom
 * would cut it off (the menu is as tall as its sections, nothing more).
 */
export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const icon = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);

  // Where it fits: worked out each time it's about to show.
  const place = () => {
    const at = icon.current?.getBoundingClientRect();
    const height = tip.current?.offsetHeight ?? 0;
    setUp(!!at && at.bottom + 6 + height > window.innerHeight && at.top - 6 - height >= 0);
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    // A tap anywhere else closes it.
    const close = (event: PointerEvent) => {
      if (!icon.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <span
      ref={icon}
      className={`info-tip${open ? " open" : ""}${up ? " up" : ""}`}
      tabIndex={0}
      role="button"
      aria-label={text}
      aria-expanded={open}
      onPointerEnter={place}
      onFocus={place}
      onClick={() => {
        place();
        setOpen((was) => !was);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          place();
          setOpen((was) => !was);
        } else if (event.key === "Escape") {
          // Out of the way at once: its focus let go too (focus shows it as well).
          setOpen(false);
          event.currentTarget.blur();
        }
      }}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          fill="currentColor"
          d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8"
        />
      </svg>
      <span ref={tip} className="info-tip-text" role="tooltip">
        {text}
      </span>
    </span>
  );
}
