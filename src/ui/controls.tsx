import { forwardRef, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Search, X } from "lucide-react";

/* Slider — one seek per gesture; keyboard and accessibility changes commit immediately. */
type SliderProps = {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  step?: number;
  onChange?: (value: number) => void;
  onCommit: (value: number) => void;
  valueText?: string;
};

export function Slider({ value, min, max, ariaLabel, className, disabled, step = 1, onChange, onCommit, valueText }: SliderProps) {
  const [local, setLocal] = useState(value);
  const pointer = useRef(false);
  const pending = useRef<number | null>(null);
  useEffect(() => {
    if (!pointer.current) setLocal(value);
  }, [value]);
  const finish = (cancel = false) => {
    pointer.current = false;
    const next = pending.current;
    pending.current = null;
    if (cancel) setLocal(value);
    else if (next !== null) onCommit(next);
  };
  const shown = Math.max(min, Math.min(local, max));
  return (
    <input
      className={`slider ${className ?? ""}`}
      aria-label={ariaLabel}
      aria-valuetext={valueText}
      type="range"
      min={min}
      max={max}
      step={step}
      value={shown}
      disabled={disabled}
      style={{ "--range-fill": `${max > min ? ((shown - min) / (max - min)) * 100 : 0}%` } as CSSProperties}
      onPointerDown={(event) => {
        pointer.current = true;
        pending.current = null;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onChange={(event) => {
        const next = Number(event.currentTarget.value);
        setLocal(next);
        onChange?.(next);
        if (pointer.current) pending.current = next;
        else onCommit(next);
      }}
      onPointerUp={() => finish()}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => finish()}
      onBlur={() => finish()}
    />
  );
}

/* Segmented control */
type SegmentedProps<T extends string> = {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
};

export function Segmented<T extends string>({ value, options, onChange, ariaLabel, className }: SegmentedProps<T>) {
  return (
    <div className={`segmented ${className ?? ""}`} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          aria-label={option.title}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* Pop-up button backed by a native <select> menu */
type PopupProps<T extends string> = {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  borderless?: boolean;
};

export function Popup<T extends string>({ value, options, onChange, ariaLabel, borderless }: PopupProps<T>) {
  return (
    <span className={`popup ${borderless ? "borderless" : ""}`}>
      <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/* Search field */
type SearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  small?: boolean;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  style?: CSSProperties;
};

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onChange, placeholder = "搜索", ariaLabel, small, onKeyDown, style },
  ref,
) {
  return (
    <div className={`search-field ${small ? "small" : ""}`} style={style}>
      <Search size={13} />
      <input
        ref={ref}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
          onKeyDown?.(event);
        }}
      />
      {value && (
        <button type="button" className="clear" aria-label="清除" tabIndex={-1} onClick={() => onChange("")}>
          <X size={10} strokeWidth={3} />
        </button>
      )}
    </div>
  );
});

/* ContentUnavailableView */
export function EmptyState({
  icon,
  title,
  message,
  children,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  message?: ReactNode;
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty ${compact ? "compact" : ""}`}>
      {icon && <div className="empty-glyph">{icon}</div>}
      <p className="empty-title">{title}</p>
      {message && <p className="empty-message">{message}</p>}
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}

/** Grow a rendered list as its end scrolls into view (instead of "load more" buttons). */
export function useIncrementalCount(total: number, step: number, resetKey: unknown) {
  const [count, setCount] = useState(step);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => setCount(step), [resetKey, step]);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || count >= total) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setCount((value) => Math.min(total, value + step));
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [count, total, step]);
  return { count: Math.min(count, total), sentinel };
}
