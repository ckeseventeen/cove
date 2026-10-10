import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { onFallbackMenu, type FallbackMenuRequest } from "../lib/native";
import { useTopmostEscape } from "./Sheet";

/** HTML stand-in for NSMenu, used only in the browser preview. */
export function MenuHost() {
  const [request, setRequest] = useState<FallbackMenuRequest | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => onFallbackMenu(setRequest), []);
  useTopmostEscape(!!request, () => setRequest(null));

  useLayoutEffect(() => {
    if (!request || !menu.current) return;
    const { width, height } = menu.current.getBoundingClientRect();
    setPosition({
      left: Math.min(request.x, window.innerWidth - width - 6),
      top: request.y + height > window.innerHeight - 6 ? Math.max(6, request.y - height) : request.y,
    });
    menu.current.querySelector<HTMLElement>(".menu-item:not(:disabled)")?.focus({ preventScroll: true });
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const close = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) setRequest(null);
    };
    const closeNow = () => setRequest(null);
    window.addEventListener("mousedown", close, true);
    window.addEventListener("blur", closeNow);
    window.addEventListener("resize", closeNow);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("blur", closeNow);
      window.removeEventListener("resize", closeNow);
    };
  }, [request]);

  if (!request) return null;
  const move = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>(".menu-item:not(:disabled)") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return (
    <div ref={menu} className="menu" role="menu" style={position} onKeyDown={move}>
      {request.items.map((item, index) =>
        item === "separator" ? (
          <div key={index} className="menu-separator" role="separator" />
        ) : (
          <button
            key={index}
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={item.checked}
            className={`menu-item ${item.destructive ? "destructive" : ""}`}
            disabled={item.enabled === false}
            onClick={() => {
              setRequest(null);
              item.action();
            }}
          >
            {item.checked !== undefined && <span style={{ width: 14 }}>{item.checked ? "✓" : ""}</span>}
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
