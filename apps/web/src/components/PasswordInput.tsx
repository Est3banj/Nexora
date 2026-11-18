import { useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id"> & {
  /** Label text; wired with htmlFor/id so the toggle button can live OUTSIDE the label. */
  id: string;
  label: string;
  /** Optional helper line, rendered as <small> inside the same grid item. */
  hint?: ReactNode;
  /** Explicit so `data-testid` is typed rather than relying on JSX hyphen rules. */
  "data-testid"?: string;
};

/**
 * Password field: label + input + reveal toggle, wrapped as ONE grid item so
 * it drops into `.admin-stack`, `.consola-fields` and the login card without
 * changing how many children the surrounding grid sees.
 *
 * Details that matter:
 *  · the toggle is a sibling of the input, never a child of the <label> —
 *    a button inside a label invites activation-behaviour surprises;
 *  · `type` flips between "password" and "text" on the SAME DOM node, so the
 *    value and the caret survive the toggle;
 *  · `onMouseDown` is prevented so a pointer press does not move focus out of
 *    the field the user is typing into (keyboard users still land on the
 *    button via Tab and toggle with Enter/Space);
 *  · the hit area is 48×48 (≥ the 44px touch minimum), icon-only, with
 *    aria-pressed + a Spanish aria-label that flips with the state.
 */
export function PasswordInput({ id, label, hint, ...inputProps }: Props) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw-field">
      <label htmlFor={id}>{label}</label>
      <div className="pw-wrap">
        <input id={id} type={show ? "text" : "password"} {...inputProps} />
        <button
          type="button"
          className="pw-toggle"
          aria-pressed={show}
          aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setShow((visible) => !visible)}
        >
          {show ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
        </button>
      </div>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}
