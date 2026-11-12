import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

export type ToastKind = "success" | "info" | "warning" | "error";
export type ToastMessage = { id: number; message: string; kind: ToastKind };

export function Toast({ toast, onClose }: { toast: ToastMessage; onClose: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [exiting, setExiting] = useState(false);
  const remaining = useRef(3500);
  useEffect(() => {
    if (hovered || focused || exiting) return;
    const start = Date.now();
    const timer = window.setTimeout(() => setExiting(true), remaining.current);
    return () => { clearTimeout(timer); remaining.current -= Date.now() - start; };
  }, [hovered, focused, exiting]);
  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(onClose, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 300);
    return () => clearTimeout(timer);
  }, [exiting, onClose]);
  return <div className={`toast toast-${toast.kind}${exiting ? " toast-exit" : ""}`} data-testid="toast"
    role={toast.kind === "error" ? "alert" : "status"}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <span>{toast.message}</span><button type="button" aria-label="Cerrar aviso" onClick={onClose}><X size={16} aria-hidden="true" /></button>
  </div>;
}
