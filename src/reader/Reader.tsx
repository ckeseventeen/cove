// The PDF reader window on Windows (macOS reads in PDFKit): one long column of pages, drawn only
// near the window, with selectable text and the page reached remembered for the library.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Minus, MoveHorizontal, Plus } from "lucide-react";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { isTauri } from "../lib/native";
import { primaryKey } from "../lib/platform";
import { fitWidthScale, PAGE_GAP, pageAt, pagesToDraw, pageTops, readerParams, stepZoom } from "../lib/reader";
import "../styles/reader.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Character maps (Chinese and Japanese PDFs) and the standard fonts, copied beside the app (vite.config.ts). */
const PDFJS_FILES = import.meta.env.DEV ? "/node_modules/pdfjs-dist/" : "/pdfjs/";
/** Fit width never enlarges a page past this; zooming further is the reader's choice. */
const FIT_LIMIT = 2;

type Size = { width: number; height: number };
type Zoom = { fit: true } | { fit: false; scale: number };

function openError(cause: unknown) {
  const name = cause instanceof Error ? cause.name : "";
  if (name === "PasswordException") return "这个 PDF 设有密码，暂时无法打开。";
  if (name === "InvalidPDFException") return "这个文件不是有效的 PDF。";
  return `无法打开这个 PDF：${cause instanceof Error ? cause.message : String(cause)}`;
}

export function Reader() {
  const params = useMemo(() => readerParams(window.location.search), []);
  const scroller = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [zoom, setZoom] = useState<Zoom>({ fit: true });
  const [frame, setFrame] = useState({ width: 0, height: 0, scrollTop: 0 });
  const [pageInput, setPageInput] = useState<string | null>(null);
  /**
   * The reader's place: a page and how far into it (a share of its height). Kept on every scroll
   * and put back whenever the layout changes (zoom, window width, a page found to be another size).
   */
  const place = useRef({ page: params.page, fraction: -1 });

  useEffect(() => {
    if (params.title) window.document.title = params.title;
    const url = params.src ?? (isTauri() ? convertFileSrc(params.file) : "");
    const task = pdfjs.getDocument({
      url,
      cMapUrl: `${PDFJS_FILES}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_FILES}standard_fonts/`,
      // Fonts are drawn without generated code, which the app's security policy does not allow.
      isEvalSupported: false,
    });
    let cancelled = false;
    task.promise
      .then(async (loaded) => {
        const first = (await loaded.getPage(1)).getViewport({ scale: 1 });
        if (cancelled) return;
        // Every page starts out the size of the first; a page that differs corrects it when drawn.
        setSizes(Array.from({ length: loaded.numPages }, () => ({ width: first.width, height: first.height })));
        setDocument(loaded);
      })
      .catch((cause) => {
        if (!cancelled) setError(openError(cause));
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [params]);

  const widest = sizes.reduce((width, size) => Math.max(width, size.width), 0);
  const scale = zoom.fit ? Math.min(FIT_LIMIT, fitWidthScale(widest, frame.width)) : zoom.scale;
  const heights = useMemo(() => sizes.map((size) => size.height * scale), [sizes, scale]);
  const tops = useMemo(() => pageTops(heights), [heights]);
  const total = tops.length ? tops[tops.length - 1] + heights[heights.length - 1] + PAGE_GAP : 0;
  const current = pageAt(tops, frame.scrollTop, frame.height);
  const [first, last] = pagesToDraw(tops, heights, frame.scrollTop, frame.height, frame.height);

  const layout = useRef({ tops, heights });
  layout.current = { tops, heights };

  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const { tops, heights } = layout.current;
    if (tops.length) {
      const page = pageAt(tops, element.scrollTop, element.clientHeight);
      place.current = { page, fraction: (element.scrollTop - tops[page]) / Math.max(1, heights[page]) };
    }
    setFrame({ width: element.clientWidth, height: element.clientHeight, scrollTop: element.scrollTop });
  }, []);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setFrame((previous) => ({ ...previous, width: element.clientWidth, height: element.clientHeight })),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !tops.length) return;
    const { page, fraction } = place.current;
    const index = Math.min(page, tops.length - 1);
    // A negative share is the page's top with its gap above, as when it is first opened.
    element.scrollTop = fraction < 0 ? tops[index] - PAGE_GAP : tops[index] + fraction * heights[index];
    measure();
  }, [tops, heights, measure]);

  // Tell the library where the reader is, once the page settles.
  useEffect(() => {
    if (!document || !isTauri() || !params.key) return;
    const timer = window.setTimeout(() => {
      void invoke("document_page_changed", { key: params.key, page: current, pageCount: document.numPages }).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [current, document, params.key]);

  const zoomTo = (next: Zoom) => setZoom(next);
  const zoomStep = (direction: 1 | -1) => zoomTo({ fit: false, scale: stepZoom(scale, direction) });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!primaryKey(event) || event.altKey) return;
      if (event.key === "=" || event.key === "+") zoomStep(1);
      else if (event.key === "-") zoomStep(-1);
      else if (event.key === "0") zoomTo({ fit: true });
      else return;
      event.preventDefault();
    };
    const element = scroller.current;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomStep(event.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    element?.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      element?.removeEventListener("wheel", onWheel);
    };
  });

  const goTo = (page: number) => {
    const element = scroller.current;
    if (!element || !tops.length) return;
    element.scrollTop = tops[Math.max(0, Math.min(tops.length - 1, page))] - PAGE_GAP;
  };

  const resize = useCallback((index: number, size: Size) => {
    setSizes((previous) => {
      const old = previous[index];
      if (!old || (Math.abs(old.width - size.width) < 0.5 && Math.abs(old.height - size.height) < 0.5)) return previous;
      const next = [...previous];
      next[index] = size;
      return next;
    });
  }, []);

  const contentWidth = Math.max(frame.width, widest * scale + PAGE_GAP * 2);
  const pages = [];
  if (document) {
    for (let index = first; index <= last; index++) {
      const width = sizes[index].width * scale;
      pages.push(
        <PdfPage
          key={index}
          document={document}
          index={index}
          scale={scale}
          style={{ top: tops[index], left: (contentWidth - width) / 2, width, height: heights[index] }}
          onSize={resize}
        />,
      );
    }
  }

  return (
    <div className="reader">
      <header className="reader-toolbar">
        <div className="reader-pages">
          {document && (
            <>
              <input
                className="reader-page-input"
                aria-label="页码"
                inputMode="numeric"
                value={pageInput ?? String(current + 1)}
                onFocus={(event) => {
                  setPageInput(String(current + 1));
                  event.currentTarget.select();
                }}
                onChange={(event) => setPageInput(event.target.value.replace(/\D/g, ""))}
                onBlur={() => setPageInput(null)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    goTo(Number(pageInput || current + 1) - 1);
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") event.currentTarget.blur();
                }}
              />
              <span className="reader-page-count">/ {document.numPages}</span>
            </>
          )}
        </div>
        <div className="reader-zoom">
          <button className="icon-btn" title="缩小" aria-label="缩小" disabled={!document} onClick={() => zoomStep(-1)}>
            <Minus size={16} />
          </button>
          <span className="reader-zoom-value">{document ? `${Math.round(scale * 100)}%` : ""}</span>
          <button className="icon-btn" title="放大" aria-label="放大" disabled={!document} onClick={() => zoomStep(1)}>
            <Plus size={16} />
          </button>
          <button
            className="icon-btn"
            title="适合宽度"
            aria-label="适合宽度"
            aria-pressed={zoom.fit}
            disabled={!document}
            onClick={() => zoomTo({ fit: true })}
          >
            <MoveHorizontal size={16} />
          </button>
        </div>
      </header>
      <div
        className="reader-scroll"
        ref={scroller}
        onScroll={measure}
      >
        {error ? (
          <p className="reader-message">{error}</p>
        ) : !document ? (
          <p className="reader-message">正在打开…</p>
        ) : (
          <div className="reader-content" style={{ width: contentWidth, height: total }}>
            {pages}
          </div>
        )}
      </div>
    </div>
  );
}

function PdfPage({
  document,
  index,
  scale,
  style,
  onSize,
}: {
  document: PDFDocumentProxy;
  index: number;
  scale: number;
  style: React.CSSProperties;
  onSize: (index: number, size: Size) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    let render: RenderTask | null = null;
    let layer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    let stopped = false;
    setDrawn(false);
    void (async () => {
      const page = await document.getPage(index + 1);
      if (stopped || !canvas.current || !text.current) return;
      const natural = page.getViewport({ scale: 1 });
      onSize(index, { width: natural.width, height: natural.height });
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const target = canvas.current;
      target.width = Math.floor(viewport.width * ratio);
      target.height = Math.floor(viewport.height * ratio);
      render = page.render({
        canvasContext: target.getContext("2d")!,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await render.promise;
      if (stopped) return;
      setDrawn(true);
      text.current.replaceChildren();
      layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text.current, viewport });
      await layer.render();
    })().catch(() => undefined);
    return () => {
      stopped = true;
      render?.cancel();
      layer?.cancel();
    };
  }, [document, index, scale, onSize]);

  return (
    <div className="reader-page" data-drawn={drawn || undefined} style={{ ...style, ["--scale-factor" as string]: scale }}>
      <canvas ref={canvas} />
      <div ref={text} className="textLayer selectable" />
    </div>
  );
}
